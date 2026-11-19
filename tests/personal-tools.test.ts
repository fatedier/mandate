import { afterEach, expect, test } from "bun:test";
import type { WaitKind } from "../src/shared/thread-dot.js";
import { freshStoresEnv, seedWorker, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { buildPersonalLabelTools, buildPersonalReadTools } from "../src/server/modules/personal/personal-tools.js";
import { labelThreadParams } from "../src/server/modules/personal/personal-tools-schema.js";
import { ThreadLabels } from "../src/server/modules/agent/thread-labels.js";
import { buildReadThreadTool } from "../src/server/modules/agent/tools/read-thread.js";
import { parseCut } from "./helpers/cut-line.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import type { CurrentVerdict } from "../src/shared/api/thread-status.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

/** The manager stop check's verdicts that show, by thread. */
const verdicts = new Map<string, CurrentVerdict>();

function setup() {
  verdicts.clear();
  env = freshStoresEnv("md-global-tools-");
  const workStore = new WorkItemStore(env.store.db);
  const planStore = new PlanStore(env.store.db);
  const busy = new Set<string>();
  const watching = new Map<string, WaitKind>();
  // Its own read tools, and read_thread, which it reuses from the manager.
  const tools = [
    ...buildPersonalReadTools({
      agentStore: env.agentStore, workersStore: env.workers, workStore, projectsStore: env.projects, planStore,
      isBusy: (threadId) => busy.has(threadId), waitKind: (threadId) => watching.get(threadId) ?? null,
      verdictOf: (threadId) => verdicts.get(threadId) ?? null
    }),
    buildReadThreadTool({ agentStore: env.agentStore })
  ];
  const personal = env.agentStore.getOrCreatePersonalThread();
  const ctx = { threadId: personal.id, wakeId: "w1" } as ToolContext;
  const call = async (name: string, args: unknown) => tools.find((t) => t.name === name)!.handler(args as never, ctx) as Promise<Record<string, unknown>>;
  const describe = (name: string) => tools.find((t) => t.name === name)!.description;
  return { env, workStore, planStore, busy, watching, call, describe };
}

test("waiting_on_you says what its list holds: what broke first, then the questions put to the user", () => {
  expect(setup().describe("waiting_on_you")).toBe(
    "List what waits on the user, most urgent first: threads whose own turn failed or stopped, questions asked of them (by a thread's manager, or a worker's question nobody took up), and, when the manager stop check is on, threads whose latest reply waits for their decision or has a result for them to read."
  );
});

test("list_threads lists every open manager thread with its state and workers, never the personal agent's thread", async () => {
  const { env, call } = setup();
  const release = env.agentStore.createManagerThread("Docs overhaul");
  env.agentStore.createManagerThread("PR reviews");
  const projectId = seedProject(env.projects, { name: "m", workingDir: "/tmp/m", tmuxSessionName: "m" });
  seedWorker(env.workers, projectId, { name: "release", ownerThreadId: release.id });
  const result = await call("list_threads", {});
  const threads = result.threads as Array<Record<string, unknown>>;
  expect(threads.map((t) => t.title).sort()).toStrictEqual(["Docs overhaul", "PR reviews"]);
  expect(threads.find((t) => t.title === "Docs overhaul")).toMatchObject({ id: release.id, workerCount: 1, state: "idle", stopReason: null });
  // Each thread counts only the workers it owns.
  expect(threads.find((t) => t.title === "PR reviews")).toMatchObject({ workerCount: 0 });
});

test("list_threads gives each thread the state the sidebar shows: a queued message is working, a reply leaving a decision is blue, a stop says why", async () => {
  const { env, call, busy } = setup();
  // A message waits to start a turn: no wake has run yet.
  const queued = env.agentStore.createManagerThread("Docs overhaul");
  busy.add(queued.id);
  const blue = env.agentStore.createManagerThread("Release plan");
  verdicts.set(blue.id, { verdict: "decision", replySeq: 2, replyText: "Ship Friday or wait?" });
  const broken = env.agentStore.createManagerThread("Cache work");
  env.agentStore.finishWake(env.agentStore.createWake({ threadId: broken.id, reason: "user", triggerMessageId: null }).id, "error", "boom");
  const halted = env.agentStore.createManagerThread("Search timeout");
  env.agentStore.finishWake(env.agentStore.createWake({ threadId: halted.id, reason: "user", triggerMessageId: null }).id, "stuck", "schedule_wake failed 5 times in a row");
  env.agentStore.createManagerThread("PR reviews");
  const threads = (await call("list_threads", {})).threads as Array<Record<string, unknown>>;
  const of = (title: string) => threads.find((t) => t.title === title);
  expect(of("Docs overhaul")).toMatchObject({ state: "working", stopReason: null });
  expect(of("Release plan")).toMatchObject({ state: "decision needed", stopReason: null });
  expect(of("Cache work")).toMatchObject({ state: "failed", stopReason: null });
  expect(of("Search timeout")).toMatchObject({ state: "stopped", stopReason: "schedule_wake failed 5 times in a row" });
  expect(of("PR reviews")).toMatchObject({ state: "idle", stopReason: null });
  // One state, not the old flags beside it.
  expect(of("Docs overhaul")).not.toHaveProperty("running");
});

// A key written in a thread stays that thread's: another agent reading it
// gets it hidden, as a history search does.
test("read_thread hides the secrets in what it reads", async () => {
  const { env, call } = setup();
  const thread = env.agentStore.createManagerThread("Gateway keys");
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Use api_key=sk-test-abcdefghijklmnop for dev" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Sent with Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", toolCalls: [] } });
  const result = await call("read_thread", { threadId: thread.id, limit: 10 });
  const texts = (result.messages as Array<{ text: string }>).map((m) => m.text);
  expect(texts.join("\n")).not.toContain("abcdefghijklmnop");
  expect(texts.every((text) => /redacted/i.test(text))).toBe(true);
});

test("read_thread returns the last visible rows of a manager thread and skips what only the model reads", async () => {
  const { env, call } = setup();
  const thread = env.agentStore.createManagerThread("PR reviews");
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "look at #14" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "runtime-context", content: { type: "text", text: "## Manager runtime context" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "fisher is on it", toolCalls: [] } });
  const result = await call("read_thread", { threadId: thread.id, limit: 10 });
  expect((result.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["look at #14", "fisher is on it"]);
  // The last N: more visible rows than asked for return only the newest.
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "and #15?" } });
  const lastTwo = await call("read_thread", { threadId: thread.id, limit: 2 });
  expect((lastTwo.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["fisher is on it", "and #15?"]);
  // The personal agent's thread is not a manager thread: refused.
  expect(await call("read_thread", { threadId: env.agentStore.getOrCreatePersonalThread().id })).toEqual({ error: expect.stringContaining("not an open manager thread") });
  expect(await call("read_thread", { threadId: "thr_missing" })).toEqual({ error: expect.stringContaining("not an open manager thread") });
});

test("read_thread cuts a long row at 4,000 characters and saves it whole for the reader", async () => {
  const { env, call } = setup();
  const thread = env.agentStore.createManagerThread("PR reviews");
  const long = `${"r".repeat(4999)}!`;
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: long, toolCalls: [] } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "s".repeat(4000) } });
  const rows = (await call("read_thread", { threadId: thread.id })).messages as Array<{ text: string; textTruncated?: boolean }>;
  expect(parseCut(rows[0]!.text)).toEqual({ kept: "r".repeat(4000), first: 4000, of: 5000, whole: long });
  expect(rows[0]!.textTruncated).toBe(true);
  expect(rows[1]).toMatchObject({ text: "s".repeat(4000) });
  expect(rows[1]!.textTruncated).toBeUndefined();
});

test("waiting_on_you lists what Home lists, labelled as Home labels it: what broke first, then questions, workers in the user's project order; a worker's failure is its manager's", async () => {
  const { env, workStore, planStore, call } = setup();
  const thread = env.agentStore.createManagerThread("Docs overhaul");
  const older = seedProject(env.projects, { name: "older", workingDir: "/tmp/o", tmuxSessionName: "o" });
  const newer = seedProject(env.projects, { name: "newer", workingDir: "/tmp/n", tmuxSessionName: "n" });
  const a = seedWorker(env.workers, older, { name: "older-asks", tmuxWindowName: "a", ownerThreadId: thread.id });
  const b = seedWorker(env.workers, newer, { name: "newer-asks", tmuxWindowName: "b", ownerThreadId: thread.id });
  planStore.update(a, { openQuestions: ["Keep the old page?"], steps: [{ title: "Rewrite", status: "in_progress" }] });
  planStore.update(b, { openQuestions: ["Drop the beta?"], steps: [{ title: "Rewrite", status: "in_progress" }] });
  // Neither asking nor broken: nothing waits on the user.
  seedWorker(env.workers, older, { name: "quiet", tmuxWindowName: "d", ownerThreadId: thread.id });
  // A worker's failure goes to its manager, not here.
  const failed = seedWorker(env.workers, older, { name: "older-failed", tmuxWindowName: "c", ownerThreadId: thread.id });
  workStore.setFailure(failed, { at: "2026-01-12T14:00:00.000Z", message: "provider returned 500", kind: "error" });
  // The user moved "newer" above "older".
  env.projects.reorderActive([newer, older]);
  const stopped = env.agentStore.createManagerThread("Docs pass");
  const wake = env.agentStore.createWake({ threadId: stopped.id, reason: "user", triggerMessageId: null });
  env.agentStore.finishWake(wake.id, "stuck", "the same call kept failing");
  const items = (await call("waiting_on_you", {})).items as Array<Record<string, unknown>>;
  expect(items.map((i) => [i.kind, i.workerName ?? i.threadTitle, i.label])).toEqual([
    ["thread", "Docs pass", "Stopped"],
    ["worker", "newer-asks", "Needs you"],
    ["worker", "older-asks", "Needs you"]
  ]);
  expect(items[0]).toMatchObject({ threadId: stopped.id, label: "Stopped", waiting: "stopped", reason: "the same call kept failing" });
});

// A question a manager put to the user waits on them at once. A worker's goes
// to its manager first, and waits on the user only when nobody took it up:
// nothing in its thread runs or will wake by itself.
test("waiting_on_you lists the questions put to the user first: a manager's at once, a worker's once its thread rests", async () => {
  const { env, planStore, busy, watching, call } = setup();
  const release = env.agentStore.createManagerThread("project-1 3.21 release");
  const docs = env.agentStore.createManagerThread("Docs overhaul");
  const projectId = seedProject(env.projects, { name: "m", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const asks = seedWorker(env.workers, projectId, { name: "evict", tmuxWindowName: "a", ownerThreadId: docs.id });
  const finished = seedWorker(env.workers, projectId, { name: "fisher", tmuxWindowName: "b", ownerThreadId: docs.id });
  planStore.update(asks, { openQuestions: ["Keep the old flag as an alias?"], steps: [{ title: "Decide", status: "in_progress" }] });
  expect(planStore.update(finished, { steps: [{ title: "Ship the fix", status: "done", note: "merged as 4f2a9c1" }] })).toMatchObject({ ok: true });
  for (const question of ["Tag 3.21 today?", "Announce it?"]) {
    env.agentStore.appendMessage({
      threadId: release.id, role: "tool", source: "self",
      content: { type: "tool_result", toolCallId: `c_${question}`, toolName: "ask_user", result: { asked: true, questionId: `q_${question.length}`, question, options: [] } }
    });
  }
  const list = async () => ((await call("waiting_on_you", {})).items as Array<Record<string, unknown>>);
  const resting = await list();
  expect(resting).toEqual([
    { kind: "question", threadId: release.id, threadTitle: "project-1 3.21 release", label: "Needs you", waiting: "input", question: "Tag 3.21 today? (+1 more)" },
    { kind: "worker", workerId: asks, workerName: "evict", label: "Needs you", waiting: "input", question: "Keep the old flag as an alias?", threadId: docs.id, threadTitle: "Docs overhaul" }
  ]);
  // Its manager is in a turn (it may be answering the worker): not the user's yet.
  busy.add(docs.id);
  expect((await list()).map((i) => [i.kind, i.workerName ?? i.threadTitle])).toEqual([["question", "project-1 3.21 release"]]);
  busy.clear();
  // The worker itself asleep on a monitor will wake by itself.
  watching.set(env.agentStore.getOrCreateThread("worker", asks).id, "pane");
  expect((await list()).map((i) => i.workerName ?? i.threadTitle)).toStrictEqual(["project-1 3.21 release"]);
  // An alarm is no wait for a worker that asked: the next move is the user's.
  watching.set(env.agentStore.getOrCreateThread("worker", asks).id, "alarm");
  expect((await list()).map((i) => i.workerName ?? i.threadTitle)).toStrictEqual(["project-1 3.21 release", "evict"]);
  // Another worker of the thread still at work on an alarm holds the question back.
  watching.clear();
  expect(planStore.update(finished, { steps: [{ title: "Watch the release", status: "in_progress" }] })).toMatchObject({ ok: true });
  watching.set(env.agentStore.getOrCreateThread("worker", finished).id, "alarm");
  expect((await list()).map((i) => i.workerName ?? i.threadTitle)).toStrictEqual(["project-1 3.21 release"]);
  watching.clear();
  // The manager's own question stays while its thread works.
  busy.add(release.id);
  expect((await list())[0]).toMatchObject({ kind: "question", threadId: release.id });
  // A worker that asks reads as its question.
  busy.clear();
  expect((await list()).find((i) => i.workerName === "evict")).toMatchObject({ label: "Needs you", question: "Keep the old flag as an alias?" });
});

test("list_threads and read_thread are described word for word", () => {
  const { describe } = setup();
  expect(describe("list_threads")).toBe(
    "List the user's open threads: id, title, labels, last activity, its state as the sidebar shows it (a stop with its reason), and how many workers each owns. With archived: true, the archived threads instead: id, title, labels, and when each was archived."
  );
  expect(describe("read_thread")).toBe(
    "Read the last N rows a person would see in a thread (the user's messages, the manager's replies, worker reports). Default 10, max 50. An archived thread can be read too; the answer then says when it was archived."
  );
});

test("list_threads with archived: true lists the archived threads instead, newest archived first; without it, the open ones", async () => {
  const { env, call } = setup();
  const open = env.agentStore.createManagerThread("PR reviews");
  const older = env.agentStore.createManagerThread("project-2 flaky upload");
  env.agentStore.archiveThread(older.id);
  await Bun.sleep(2);
  const newer = env.agentStore.createManagerThread("project-1 cache expiry");
  env.agentStore.archiveThread(newer.id);
  const archived = (await call("list_threads", { archived: true })).threads as Array<Record<string, unknown>>;
  expect(archived.map((t) => [t.id, t.title])).toEqual([[newer.id, "project-1 cache expiry"], [older.id, "project-2 flaky upload"]]);
  expect(archived.map((t) => Object.keys(t).sort())).toEqual([["archivedAt", "id", "labels", "title"], ["archivedAt", "id", "labels", "title"]]);
  expect(archived[0]!.archivedAt).toBe(env.agentStore.getThreadById(newer.id)!.archivedAt);
  for (const args of [{}, { archived: false }]) {
    expect(((await call("list_threads", args)).threads as Array<{ id: string }>).map((t) => t.id)).toEqual([open.id]);
  }
});

test("read_thread reads an archived thread too, and says when it was archived", async () => {
  const { env, call } = setup();
  const thread = env.agentStore.createManagerThread("project-1 cache expiry");
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "ship it" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Merged as #15.", toolCalls: [] } });
  const open = await call("read_thread", { threadId: thread.id });
  expect(Object.keys(open)).toEqual(["messages"]);
  env.agentStore.archiveThread(thread.id);
  const result = await call("read_thread", { threadId: thread.id });
  expect(result.archivedAt).toBe(env.agentStore.getThreadById(thread.id)!.archivedAt);
  expect((result.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["ship it", "Merged as #15."]);
});

// Its list is Home's, blue rows included, each with the reply it is about.
test("waiting_on_you lists a stopped thread's decision with its reply", async () => {
  const { env, call } = setup();
  const plan = env.agentStore.createManagerThread("Release plan");
  verdicts.set(plan.id, { verdict: "decision", replySeq: 2, replyText: "Ship Friday or wait?" });
  expect((await call("waiting_on_you", {})).items).toEqual([
    { kind: "thread", threadId: plan.id, threadTitle: "Release plan", label: "Decision needed", waiting: "decision", reason: "Ship Friday or wait?" }
  ]);
});

// Thread labels: the agent reads them with the threads, and puts one on or
// takes one off with label_thread, as itself.
function labelTools() {
  const { env, call } = setup();
  const published: string[] = [];
  const threadLabels = new ThreadLabels({ agentStore: env.agentStore, publish: (threadId) => { published.push(threadId); } });
  const [tool, ...others] = buildPersonalLabelTools({ threadLabels });
  const personal = env.agentStore.getOrCreatePersonalThread();
  const label = (args: unknown) => tool!.handler(args as never, { threadId: personal.id, wakeId: "w1" } as ToolContext) as Promise<Record<string, unknown>>;
  return { env, call, threadLabels, tool: tool!, others, label, published };
}

test("list_threads rows carry each thread's labels by name, open and archived", async () => {
  const { env, call, threadLabels } = labelTools();
  const open = env.agentStore.createManagerThread("PR reviews");
  const old = env.agentStore.createManagerThread("project-2 flaky upload");
  threadLabels.add(open.id, "billing", "owner");
  threadLabels.add(open.id, "3.21", "agent");
  threadLabels.add(old.id, "voice", "agent");
  env.agentStore.archiveThread(old.id);
  const bare = env.agentStore.createManagerThread("Unlabelled");
  const rows = (await call("list_threads", {})).threads as Array<{ id: string; labels: string[] }>;
  expect(Object.fromEntries(rows.map((t) => [t.id, t.labels]))).toEqual({ [open.id]: ["billing", "3.21"], [bare.id]: [] });
  expect(((await call("list_threads", { archived: true })).threads as Array<{ labels: string[] }>).map((t) => t.labels)).toEqual([["voice"]]);
});

test("label_thread puts a label on as the agent's, takes one off with remove: true, and answers the thread's labels", async () => {
  const { env, tool, others, label, published } = labelTools();
  expect([tool.name, others]).toEqual(["label_thread", []]);
  const thread = env.agentStore.createManagerThread("PR reviews");
  expect(await label({ threadId: thread.id, label: "billing" })).toEqual({ labels: ["billing"] });
  expect(env.agentStore.threadLabels(thread.id)).toEqual([{ name: "billing", by: "agent" }]);
  expect(await label({ threadId: thread.id, label: "3.21", remove: false })).toEqual({ labels: ["billing", "3.21"] });
  expect(await label({ threadId: thread.id, label: "Billing", remove: true })).toEqual({ labels: ["3.21"] });
  expect(published).toEqual([thread.id, thread.id, thread.id]);
  // An archived thread can be labelled too.
  env.agentStore.archiveThread(thread.id);
  expect(await label({ threadId: thread.id, label: "voice" })).toEqual({ labels: ["3.21", "voice"] });
});

test("label_thread answers a refusal in its words", async () => {
  const { env, label } = labelTools();
  const thread = env.agentStore.createManagerThread("PR reviews");
  expect(await label({ threadId: "thr_x", label: "billing" })).toEqual({ error: "No such thread: thr_x." });
  expect(await label({ threadId: thread.id, label: "x".repeat(41) })).toEqual({ error: "A label is a word or two: at most 40 characters." });
  expect(await label({ threadId: thread.id, label: "billing", remove: true })).toEqual({ error: 'That thread has no label "billing".' });
});

test("label_thread and its parameters are described word for word", () => {
  const { tool } = labelTools();
  expect(tool.description).toBe(
    "Add a label to a thread, or take one off with remove: true. Labels are a word or two the user sorts and filters threads by, shared with the task board's. Use a label already in use when one fits."
  );
  expect(tool.parameters).toBe(labelThreadParams);
  const shape = labelThreadParams.shape;
  expect([shape.threadId.description, shape.label.description, shape.remove.description]).toEqual([
    "A thread from list_threads, open or archived.",
    "The label, at most 40 characters.",
    "true takes the label off instead of adding it."
  ]);
  // Required and optional as said: a thread and a label, remove left out.
  expect(labelThreadParams.safeParse({ threadId: "thr_1", label: "billing" }).success).toBe(true);
  expect(labelThreadParams.safeParse({ threadId: "", label: "billing" }).success).toBe(false);
  expect(labelThreadParams.safeParse({ threadId: "thr_1" }).success).toBe(false);
});
