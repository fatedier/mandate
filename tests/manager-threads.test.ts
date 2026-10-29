import { expect, test } from "bun:test";
import { answersMetadata } from "../src/shared/questions.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import {
  ManagerThreadService,
  normalizeThreadTitle,
  startManagerThreadBroadcast
} from "../src/server/modules/agent/manager-threads.js";
import { buildNameThreadTool } from "../src/server/modules/agent/tools/thread-tools.js";

test("normalizeThreadTitle: one line, trimmed, 1–80 chars", () => {
  expect(normalizeThreadTitle("  project-1   3.21\nrelease ")).toBe("project-1 3.21 release");
  expect(normalizeThreadTitle("")).toBe(null);
  expect(normalizeThreadTitle("   ")).toBe(null);
  expect(normalizeThreadTitle(42)).toBe(null);
  expect(normalizeThreadTitle("x".repeat(81))).toBe(null);
  expect(normalizeThreadTitle("x".repeat(80))).toBe("x".repeat(80));
});

test("dto: title falls back to the first user line cut at 60, then 'New thread'", () => {
  const env = freshAgentEnv("md-mt-dto-");
  const svc = new ManagerThreadService({ agentStore: env.agentStore });
  const t = env.agentStore.createManagerThread();
  expect(svc.dto(t.id)).toMatchObject({ title: "New thread", named: false, lastVisibleSeq: 0, seenSeq: 0, running: false, archivedAt: null });
  env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "a".repeat(70) } });
  expect(svc.dto(t.id)?.title).toBe("a".repeat(60) + "…");
  env.agentStore.setThreadTitle(t.id, "Named");
  expect(svc.dto(t.id)).toMatchObject({ title: "Named", named: true });
});

test("dto: a worker thread or a side thread is not a manager thread", () => {
  const env = freshAgentEnv("md-mt-dto2-");
  const svc = new ManagerThreadService({ agentStore: env.agentStore });
  const w = env.agentStore.getOrCreateThread("worker", "feat_x");
  expect(svc.dto(w.id)).toBe(null);
  expect(svc.dto("thr_missing")).toBe(null);
});

test("list: open threads only, newest activity first", () => {
  const env = freshAgentEnv("md-mt-list-");
  const svc = new ManagerThreadService({ agentStore: env.agentStore });
  const a = env.agentStore.createManagerThread("A");
  const b = env.agentStore.createManagerThread("B");
  const c = env.agentStore.createManagerThread("C");
  const at = (id: string, when: string) => {
    const m = env.agentStore.appendMessage({ threadId: id, role: "user", source: "user", content: { type: "text", text: "x" } });
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(when, m.id);
  };
  at(a.id, "2026-09-27T09:00:00.000Z");
  at(b.id, "2026-09-27T11:00:00.000Z");
  env.agentStore.archiveThread(c.id);
  expect(svc.list().map((t) => t.title)).toEqual(["B", "A"]);
});

test("rename / nameByAgent / markSeen publish managerThreadUpdated; a name kept or refused does not", () => {
  const env = freshAgentEnv("md-mt-pub-");
  const sse = new AgentSseEmitter();
  const seen: unknown[] = [];
  sse.addSink((e) => { if (e.event === "managerThreadUpdated") seen.push(e.data); });
  const svc = new ManagerThreadService({ agentStore: env.agentStore, sse });
  const t = env.agentStore.createManagerThread();
  expect(svc.nameByAgent(t.id, "Release")).toEqual({ kind: "named", title: "Release" });
  expect(svc.nameByAgent(t.id, " Release ")).toEqual({ kind: "same", title: "Release" });
  expect(svc.nameByAgent(t.id, "Other")).toEqual({ kind: "renamed", title: "Other", previous: "Release" });
  expect(svc.nameByAgent(t.id, "")).toEqual({ error: "title must be 1-80 characters on one line" });
  expect(svc.rename(t.id, "Mine")).toMatchObject({ title: "Mine" });
  expect(svc.nameByAgent(t.id, "Theirs")).toEqual({ kind: "user", title: "Mine" });
  expect(svc.rename(t.id, "")).toEqual({ error: "title must be 1-80 characters on one line" });
  expect(svc.markSeen(t.id, 5)).toMatchObject({ seenSeq: 5 });
  expect(svc.rename("thr_missing", "x")).toEqual({ error: "thread not found" });
  expect(svc.nameByAgent("thr_missing", "x")).toEqual({ error: "thread not found" });
  expect(seen.length).toBe(4);
});

test("broadcast: a manager thread's message or wake re-publishes its DTO once, after the event", async () => {
  const env = freshAgentEnv("md-mt-bc-");
  // Opened before the service: its creation is not what this test counts.
  const t = env.agentStore.createManagerThread("T");
  const sse = new AgentSseEmitter();
  const order: string[] = [];
  sse.addSink((e) => order.push(e.event === "managerThreadUpdated" ? `updated:${(e.data as { thread: { id: string } }).thread.id}` : e.event));
  const svc = new ManagerThreadService({ agentStore: env.agentStore, sse });
  const stop = startManagerThreadBroadcast({ sse, service: svc, agentStore: env.agentStore });
  const w = env.agentStore.getOrCreateThread("worker", "feat_x");
  const m = env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  sse.emit("agentMessageAppended", { threadId: t.id, message: m });
  sse.emit("agentWakeStarted", { threadId: w.id, wakeId: "wk_1", reason: "user", startedAt: "2026-09-29T10:00:00.000Z", scope: "worker", scopeId: "feat_x" });
  await Promise.resolve();
  expect(order).toStrictEqual(["agentMessageAppended", "agentWakeStarted", `updated:${t.id}`]);
  stop();
  sse.emit("agentMessageAppended", { threadId: t.id, message: m });
  await Promise.resolve();
  expect(order.filter((e) => e.startsWith("updated")).length).toBe(1);
});

// The manager names a thread in its first reply and renames it when the
// user moves it on to another task; a name the user set stays.
test("name_thread: names the thread, renames it when the task changes, and keeps a name the user set", async () => {
  const env = freshAgentEnv("md-mt-tool-");
  const sse = new AgentSseEmitter();
  const published: string[] = [];
  sse.addSink((e) => { if (e.event === "managerThreadUpdated") published.push((e.data as { thread: { title: string } }).thread.title); });
  const svc = new ManagerThreadService({ agentStore: env.agentStore, sse });
  const tool = buildNameThreadTool(svc);
  const t = env.agentStore.createManagerThread();
  const ctx = toolContext({ threadId: t.id, wakeId: "wk" });
  const title = () => env.agentStore.getThreadById(t.id)?.title;
  expect(await tool.handler({ title: "Research project-1 PR 48" }, ctx)).toBe('Named this thread "Research project-1 PR 48".');
  expect(await tool.handler({ title: "Research project-1 PR 48" }, ctx)).toBe('This thread is already named "Research project-1 PR 48".');
  expect(await tool.handler({ title: "Research project-1 Issue 72" }, ctx)).toBe('Renamed this thread "Research project-1 Issue 72" (was "Research project-1 PR 48").');
  expect(title()).toBe("Research project-1 Issue 72");
  // The user renames it: from then on the manager's names change nothing.
  svc.rename(t.id, "Issue 72 code reading");
  expect(await tool.handler({ title: "project-1 Export API v2" }, ctx)).toBe('The user named this thread "Issue 72 code reading"; it stays.');
  expect(title()).toBe("Issue 72 code reading");
  // Each change reached the sidebar once; a repeat or a refusal did not.
  expect(published).toStrictEqual(["Research project-1 PR 48", "Research project-1 Issue 72", "Issue 72 code reading"]);
});

test("name_thread: a title given when the thread was opened is the user's; one a worker or a handoff opened it with is the manager's", async () => {
  const env = freshAgentEnv("md-mt-tool-open-");
  const svc = new ManagerThreadService({ agentStore: env.agentStore });
  const tool = buildNameThreadTool(svc);
  // Opened through the API with a title (POST /api/agents/manager/threads).
  const asked = svc.create("project-1 3.22 release");
  expect(await tool.handler({ title: "project-1 release day" }, toolContext({ threadId: asked.id, wakeId: "wk" }))).toBe('The user named this thread "project-1 3.22 release"; it stays.');
  // Opened by the server, named after what it is for.
  const opened = env.agentStore.createManagerThread("project-2 cache expiry");
  expect(await tool.handler({ title: "project-2 expiry callback" }, toolContext({ threadId: opened.id, wakeId: "wk" }))).toBe('Renamed this thread "project-2 expiry callback" (was "project-2 cache expiry").');
});

test("every manager thread the store opens is announced, whichever path opened it", () => {
  const env = freshAgentEnv("md-mt-announce-");
  const seen: Array<string | null> = [];
  const stop = env.agentStore.onManagerThreadCreated((t) => seen.push(t.title));
  env.agentStore.createManagerThread("pr-33");
  // No thread open: the fallback opens one.
  env.agentStore.archiveThread(env.agentStore.latestManagerThread().id);
  env.agentStore.latestManagerThread("project-2");
  // An open one exists: nothing is opened.
  env.agentStore.latestManagerThread("unused");
  env.agentStore.getOrCreateThread("worker", "feat_1");
  stop();
  env.agentStore.createManagerThread("after");
  expect(seen).toStrictEqual(["pr-33", "project-2"]);
});

test("broadcast: a thread opened outside the service is published once; one it creates, once too", () => {
  const env = freshAgentEnv("md-mt-pub-created-");
  const sse = new AgentSseEmitter();
  const seen: string[] = [];
  sse.addSink((e) => { if (e.event === "managerThreadUpdated") seen.push((e.data as { thread: { title: string } }).thread.title); });
  const svc = new ManagerThreadService({ agentStore: env.agentStore, sse });
  const stop = startManagerThreadBroadcast({ sse, service: svc, agentStore: env.agentStore });
  // A worker created with no thread gets one named after it.
  env.agentStore.createManagerThread("EvictHook");
  svc.create("Release project-1 3.21");
  stop();
  env.agentStore.createManagerThread("after");
  expect(seen).toStrictEqual(["EvictHook", "Release project-1 3.21"]);
});

test("list: two threads opened in the same millisecond list the newer one first, as the latest-thread choice picks it", () => {
  const env = freshAgentEnv("md-mt-tie-");
  const svc = new ManagerThreadService({ agentStore: env.agentStore });
  const older = env.agentStore.createManagerThread("Older");
  const newer = env.agentStore.createManagerThread("Newer");
  env.store.db.prepare("update agent_threads set created_at = '2026-09-27T12:00:00.000Z', updated_at = '2026-09-27T12:00:00.000Z' where id in (?, ?)").run(older.id, newer.id);
  expect(svc.list().map((t) => t.title)).toEqual(["Newer", "Older"]);
  expect(env.agentStore.latestManagerThread().id).toBe(newer.id);
});

test("a manager thread whose newest wake errored is failed until another wake starts", () => {
  const env = freshAgentEnv("md-failed-wakes-");
  const agent = env.agentStore;
  const svc = new ManagerThreadService({ agentStore: agent });
  const thread = agent.createManagerThread("t");
  expect(svc.dto(thread.id)?.failed).toBe(false);
  const ask = agent.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const first = agent.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
  agent.finishWake(first.id, "error", "Model request timed out. Please retry.");
  expect(svc.dto(thread.id)?.failed).toBe(true);
  const retry = agent.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
  expect(svc.dto(thread.id)).toMatchObject({ failed: false, running: true });
  agent.finishWake(retry.id, "finished");
  expect(svc.dto(thread.id)?.failed).toBe(false);
  const clean = agent.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
  agent.finishWake(clean.id, "finished");
  expect(svc.dto(thread.id)?.failed).toBe(false);
  // A turn stopped repeating a failing call needs you as an error does.
  const stuck = agent.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
  agent.finishWake(stuck.id, "stuck", "read failed 5 times in a row: ENOENT");
  expect(svc.dto(thread.id)?.failed).toBe(true);
});

test("a manager thread stopped by the repeat check carries its reason until another wake starts; an error carries none", () => {
  const env = freshAgentEnv("md-stopped-thread-");
  const agent = env.agentStore;
  const svc = new ManagerThreadService({ agentStore: agent });
  const thread = agent.createManagerThread("t");
  expect(svc.dto(thread.id)?.stopReason).toBe(null);
  const ask = agent.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const errored = agent.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
  agent.finishWake(errored.id, "error", "Model request timed out. Please retry.");
  expect(svc.dto(thread.id)).toMatchObject({ failed: true, stopReason: null });
  const stuck = agent.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
  agent.finishWake(stuck.id, "stuck", "schedule_wake failed 5 times in a row: when: Invalid input");
  expect(svc.dto(thread.id)).toMatchObject({ failed: true, stopReason: "schedule_wake failed 5 times in a row: when: Invalid input" });
  agent.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
  expect(svc.dto(thread.id)).toMatchObject({ failed: false, stopReason: null, running: true });
});

test("dto: a thread carries the questions its manager asked and the user has not answered", () => {
  const env = freshAgentEnv("md-mt-questions-");
  const svc = new ManagerThreadService({ agentStore: env.agentStore });
  const t = env.agentStore.createManagerThread("Release");
  expect(svc.dto(t.id)!.questions).toEqual([]);
  const asked = env.agentStore.appendMessage({
    threadId: t.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: "q_1", question: "Push the branch?", options: [{ label: "Push now" }, { label: "Hold it" }] } }
  });
  expect(svc.dto(t.id)!.questions).toEqual([{ id: "q_1", question: "Push the branch?", options: [{ label: "Push now" }, { label: "Hold it" }], askedAt: asked.createdAt }]);
  expect(svc.list().find((x) => x.id === t.id)!.questions.map((q) => q.id)).toEqual(["q_1"]);
  // Words that name no question leave it open; the answer to it closes it.
  env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "Push it." } });
  expect(svc.dto(t.id)!.questions.map((q) => q.id)).toEqual(["q_1"]);
  env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "Push now", metadata: answersMetadata([{ id: "q_1", question: "Push the branch?" }]) } });
  expect(svc.dto(t.id)!.questions).toEqual([]);
});
