import { expect, test } from "bun:test";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import type { MandateStore } from "../../src/server/app/store.js";
import { buildAgentsTestApp, buildTestScopes, postJson } from "../helpers/test-app.js";
import { freshAgentEnv } from "../helpers/fixtures.js";

function buildAppWithRecorder(agentStore: AgentStore, store: MandateStore) {
  const wakes: Array<{ threadId: string; reason: string; msgId: string | null }> = [];
  const app = buildAgentsTestApp({
    agentStore,
    wakeScheduler: { wake: (threadId, reason, msgId) => {
      wakes.push({ threadId, reason, msgId });
      return `wake-${wakes.length}`;
    } },
    scopes: buildTestScopes(new FeaturesStore(store.db))
  });
  return { app, wakes };
}

// A manager thread is addressed by its id: /api/agents/threads/:id.

test("a message to a manager thread is appended and wakes the manager; once the thread is archived, its route refuses one", async () => {
  const { store, agentStore } = freshAgentEnv("md-ov-mflow-");
  const { app, wakes } = buildAppWithRecorder(agentStore, store);
  const thread = agentStore.createManagerThread("Release");
  const r = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "hello manager" });
  expect(r.status).toBe(202);
  expect(r.body.threadId).toBe(thread.id);
  expect(r.body.messageId).toBeTruthy();
  expect(r.body.wakeId).toBeTruthy();
  const msgs = agentStore.getActiveMessages(thread.id);
  expect(msgs.map((m) => [m.role, m.source, (m.content as { text?: string }).text])).toEqual([["user", "user", "hello manager"]]);
  expect(wakes.map((w) => [w.threadId, w.reason])).toStrictEqual([[thread.id, "user"]]);
  agentStore.archiveThread(thread.id);
  expect((await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "late" })).status).toBe(404);
  expect(wakes).toHaveLength(1);
});

test("an empty message to a manager thread is refused", async () => {
  const { store, agentStore } = freshAgentEnv("md-ov-mflow-");
  const { app } = buildAppWithRecorder(agentStore, store);
  const thread = agentStore.createManagerThread("Release");
  const r = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "   " });
  expect(r.status).toBe(400);
  expect(String(r.body.error)).toMatch(/content or image attachment is required/i);
});

function ask(agentStore: AgentStore, threadId: string, id: string, question: string) {
  agentStore.appendMessage({
    threadId, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: `call_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options: [{ label: "Push now" }, { label: "Hold it" }] } }
  });
}

test("a pick is sent as the user's message, marked with the question it answers, and closes that question only", async () => {
  const { store, agentStore } = freshAgentEnv("md-ov-pick-");
  const { app, wakes } = buildAppWithRecorder(agentStore, store);
  const thread = agentStore.createManagerThread("Release");
  ask(agentStore, thread.id, "q_1", "Push the branch?");
  ask(agentStore, thread.id, "q_2", "Tag it too?");
  const r = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "Push now", answers: ["q_1"] });
  expect(r.status).toBe(202);
  const sent = agentStore.getActiveMessages(thread.id).at(-1)!;
  // The question's own words are looked up here, never taken from the page.
  expect(sent.content).toEqual({ type: "text", text: "Push now", metadata: { answers: [{ id: "q_1", question: "Push the branch?" }] } });
  expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_2"]);
  expect(wakes.length).toBe(1);
});

test("a pick for a question that is no longer open is refused, and nothing else closes", async () => {
  const { store, agentStore } = freshAgentEnv("md-ov-stale-");
  const { app, wakes } = buildAppWithRecorder(agentStore, store);
  const thread = agentStore.createManagerThread("Release");
  ask(agentStore, thread.id, "q_2", "Tag it too?");
  const before = agentStore.getActiveMessages(thread.id).length;
  // q_1 was answered in another window: this click is late.
  const r = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "Push now", answers: ["q_1"] });
  expect(r.status).toBe(409);
  expect(r.body.error).toBe("That question is no longer open.");
  expect(agentStore.getActiveMessages(thread.id).length).toBe(before);
  expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_2"]);
  expect(wakes).toStrictEqual([]);
  // One open and one not: still refused as a whole.
  const mixed = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "Both", answers: ["q_2", "q_1"] });
  expect(mixed.status).toBe(409);
  expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_2"]);
});

test("Continue is the user's message and wakes the thread, and answers no question; nor does the same word typed", async () => {
  const { store, agentStore } = freshAgentEnv("md-ov-continue-");
  const { app, wakes } = buildAppWithRecorder(agentStore, store);
  const thread = agentStore.createManagerThread("Release");
  ask(agentStore, thread.id, "q_1", "Push the branch?");
  const pressed = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "Continue", control: "continue" });
  expect(pressed.status).toBe(202);
  const sent = agentStore.getActiveMessages(thread.id).at(-1)!;
  expect([sent.role, sent.source, sent.content]).toEqual(["user", "user", { type: "text", text: "Continue", metadata: { control: "continue" } }]);
  expect(wakes.length).toBe(1);
  expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1"]);
  // A control the server does not know is no control: the message is typed.
  await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "Continue", control: "resume" });
  expect(agentStore.getActiveMessages(thread.id).at(-1)!.content).toEqual({ type: "text", text: "Continue" });
  expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1"]);
});

test("answers that are not a list of ids are refused; none or an empty list is a typed message", async () => {
  const { store, agentStore } = freshAgentEnv("md-ov-answers-shape-");
  const { app } = buildAppWithRecorder(agentStore, store);
  const thread = agentStore.createManagerThread("Release");
  ask(agentStore, thread.id, "q_1", "Push the branch?");
  for (const answers of ["q_1", [7], [""], { id: "q_1" }, null]) {
    const r = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "Push now", answers });
    expect([JSON.stringify(answers), r.status, r.body.error]).toEqual([JSON.stringify(answers), 400, "answers must be a list of question ids"]);
  }
  expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1"]);
  const typed = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "Yes, push it.", answers: [] });
  expect(typed.status).toBe(202);
  expect(agentStore.getActiveMessages(thread.id).at(-1)!.content).toEqual({ type: "text", text: "Yes, push it." });
  // Typed: it names no question, and answers none.
  expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1"]);
});

test("the same id twice in a pick is one answer", async () => {
  const { store, agentStore } = freshAgentEnv("md-ov-pick-twice-");
  const { app } = buildAppWithRecorder(agentStore, store);
  const thread = agentStore.createManagerThread("Release");
  ask(agentStore, thread.id, "q_1", "Push the branch?");
  const r = await postJson(app, `/api/agents/threads/${thread.id}/messages`, { content: "Push now", answers: ["q_1", "q_1"] });
  expect(r.status).toBe(202);
  expect((agentStore.getActiveMessages(thread.id).at(-1)!.content as { metadata?: unknown }).metadata).toEqual({ answers: [{ id: "q_1", question: "Push the branch?" }] });
});

test("Skip closes an open question without waking its asker; a question no longer open, or a thread that is not, is refused", async () => {
  const { store, agentStore } = freshAgentEnv("md-ov-skip-");
  const { app, wakes } = buildAppWithRecorder(agentStore, store);
  const thread = agentStore.createManagerThread("Release");
  ask(agentStore, thread.id, "q_1", "Push the branch?");
  ask(agentStore, thread.id, "q_2", "Tag it too?");
  const r = await postJson(app, `/api/agents/threads/${thread.id}/questions/q_2/skip`, {});
  expect(r.status).toBe(200);
  expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1"]);
  expect(agentStore.getActiveMessages(thread.id).at(-1)!.source).toBe("question-skip");
  expect(wakes).toStrictEqual([]);

  const rows = agentStore.getActiveMessages(thread.id).length;
  const again = await postJson(app, `/api/agents/threads/${thread.id}/questions/q_2/skip`, {});
  expect([again.status, again.body.error]).toEqual([409, "That question is no longer open."]);
  expect(agentStore.getActiveMessages(thread.id).length).toBe(rows);
  expect((await postJson(app, "/api/agents/threads/thr_missing/questions/q_1/skip", {})).status).toBe(404);
  // An archived thread's question is not the user's to skip any more.
  agentStore.archiveThread(thread.id);
  expect((await postJson(app, `/api/agents/threads/${thread.id}/questions/q_1/skip`, {})).status).toBe(404);
  expect(agentStore.getActiveMessages(thread.id).length).toBe(rows);
});
