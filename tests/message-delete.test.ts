import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import type { ScopeRuntime } from "../src/server/runtime/scope.js";
import { startSideChatBroadcast } from "../src/server/modules/side-chat/side-chat-service.js";
import { deleteJson, getJson } from "./helpers/test-app.js";
import { MessageDeletion } from "../src/server/modules/agent/message-delete.js";
import { indexAgentHistoryMessage } from "../src/server/modules/agent/history-store.js";
import { answersMetadata } from "../src/shared/questions.js";
import { mountAgentsRoutes } from "../src/server/modules/agent/agents-api.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import type { AgentMessageContent } from "../src/shared/agent-message-types.js";

// The owner deletes a message of their own that the agent has not answered:
// one they typed, with nothing from the agent after it before the next
// message that came in, and no turn of it still running. It goes from the
// conversation the agent reads, from search, and from every open page.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const ANSWERED = "The agent has answered this message, so it can't be deleted.";
const WORKING = "The agent is working on this message. Stop it first.";

function setup(prefix: string, running: () => boolean = () => false, now?: () => number) {
  env = freshStoresEnv(prefix);
  const store = env.agentStore;
  const thread = store.createManagerThread("Billing research");
  const events: Array<[string, unknown]> = [];
  const told: string[] = [];
  const deletion = new MessageDeletion({
    db: env.store.db, agentStore: store, isRunning: running, ...(now ? { now } : {}),
    sse: { emit: (event: string, data: unknown) => { events.push([event, data]); } } as never,
    onDeleted: (threadId) => { told.push(threadId); }
  });
  const add = (role: "user" | "assistant" | "tool" | "system", source: string, content: AgentMessageContent) =>
    store.appendMessage({ threadId: thread.id, role, source: source as never, content });
  return {
    env, store, thread, deletion, events, told,
    say: (text: string, over: Record<string, unknown> = {}) => add("user", "user", { type: "text", text, ...over } as AgentMessageContent),
    context: () => add("user", "runtime-context", { type: "text", text: "[runtime_context]\nNothing new.", metadata: { runtimeContextKind: "update" } }),
    reply: (text: string) => add("assistant", "self", { type: "assistant", text } as AgentMessageContent),
    result: () => add("tool", "self", { type: "tool_result", toolCallId: "call_1", toolName: "bash", result: "ok" } as AgentMessageContent),
    failed: () => add("system", "wake-failure", { type: "wake_failure", status: "error", message: "LLM call failed", stepCount: 0 }),
    notice: (text: string) => add("user", "thread-notice", { type: "text", text }),
    /** A row the runtime writes for the model alone, or a note the model reads and the chat never draws. */
    unseen: (source: "plan-reminder" | "output-limit" | "page-input") => add("user", source, { type: "text", text: `[${source}]` }),
    texts: () => store.getMessagesPage(thread.id, { limit: 50 }).map((m) => `${m.source}:${m.content.type === "text" || m.content.type === "assistant" ? m.content.text : m.content.type}`).reverse()
  };
}

test("a message the agent has not answered is deleted, and the agent's window no longer holds it", () => {
  const t = setup("md-msgdel-plain-");
  t.reply("Earlier answer.");
  const stray = t.say("waf");
  t.context();
  // Read once before: the window is held between reads.
  expect(t.store.getActiveMessages(t.thread.id).some((m) => m.id === stray.id)).toBe(true);
  expect(t.deletion.delete(t.thread.id, stray.id)).toEqual({ ok: true, removed: [stray.id] });
  expect(t.store.getMessageById(stray.id)).toBe(null);
  expect(t.store.getActiveMessages(t.thread.id).map((m) => m.source)).toEqual(["self", "runtime-context"]);
  // Every open page is told, and whoever keeps the thread's summary.
  expect(t.events).toEqual([[SSE_EVENTS.agentMessageDeleted, { threadId: t.thread.id, messageIds: [stray.id] }]]);
  expect(t.told).toEqual([t.thread.id]);
});

test("with a later message after it, still unanswered, it is deleted while that one's turn runs", () => {
  const t = setup("md-msgdel-later-", () => true);
  const stray = t.say("waf");
  t.context();
  t.notice("[Thread notice] Another thread stopped.");
  t.reply("About that thread.");
  expect(t.deletion.delete(t.thread.id, stray.id)).toMatchObject({ ok: true });
  expect(t.texts()).toEqual(["runtime-context:[runtime_context]\nNothing new.", "thread-notice:[Thread notice] Another thread stopped.", "self:About that thread."]);
});

test("the line a failed turn left under it goes with it", () => {
  const t = setup("md-msgdel-failed-");
  const stray = t.say("Start the report");
  t.context();
  const failure = t.failed();
  const next = t.say("Try again");
  expect(t.deletion.delete(t.thread.id, stray.id)).toEqual({ ok: true, removed: [stray.id, failure.id] });
  expect(t.store.getMessageById(failure.id)).toBe(null);
  expect(t.store.getMessageById(next.id) !== null).toBe(true);
});

test("a message the agent answered, by a reply or by a tool call, is refused and stays", () => {
  const t = setup("md-msgdel-answered-");
  const first = t.say("Start the report");
  t.reply("On it.");
  const second = t.say("And the appendix");
  t.context();
  t.result();
  for (const message of [first, second]) {
    expect(t.deletion.delete(t.thread.id, message.id)).toEqual({ ok: false, status: 409, error: ANSWERED });
    expect(t.store.getMessageById(message.id) !== null).toBe(true);
  }
  expect(t.events).toEqual([]);
});

test("the last message is refused while its turn runs", () => {
  let running = true;
  const t = setup("md-msgdel-running-", () => running);
  const last = t.say("Start the report");
  t.context();
  expect(t.deletion.delete(t.thread.id, last.id)).toEqual({ ok: false, status: 409, error: WORKING });
  running = false;
  expect(t.deletion.delete(t.thread.id, last.id)).toMatchObject({ ok: true });
});

test("only a message the owner typed: not one sent for them, an answer to a question, another kind of row, or another thread's", () => {
  const t = setup("md-msgdel-kinds-");
  const relayed = t.say("Build the price table.", { relay: { by: "personal", spoken: false, handoffId: "hof_1", name: "Juno" } });
  const answer = t.say("Yes, ship it.", { metadata: answersMetadata([{ id: "q_1", question: "Ship it?" }]) });
  const notice = t.notice("[Thread notice] stopped.");
  const reply = t.reply("Done.");
  const other = t.store.createManagerThread("Another");
  const elsewhere = t.store.appendMessage({ threadId: other.id, role: "user", source: "user", content: { type: "text", text: "hello" } });
  for (const id of [relayed.id, answer.id, notice.id, reply.id, "msg_missing"]) {
    expect(t.deletion.delete(t.thread.id, id)).toEqual({ ok: false, status: 404, error: "message not found" });
  }
  expect(t.deletion.delete(t.thread.id, elsewhere.id)).toEqual({ ok: false, status: 404, error: "message not found" });
  expect(t.deletion.delete("thr_missing", elsewhere.id)).toEqual({ ok: false, status: 404, error: "message not found" });
  expect(t.store.getMessageById(elsewhere.id) !== null).toBe(true);
});

test("a deleted message is no longer found by search", () => {
  const t = setup("md-msgdel-search-");
  const stray = t.say("quokka migration notes");
  indexAgentHistoryMessage(t.env.store.db, stray);
  const found = () => (t.env.store.db.prepare(`select count(*) as n from agent_message_search_entries where message_id = ?`).get(stray.id) as { n: number }).n;
  expect(found()).toBe(1);
  expect(t.deletion.delete(t.thread.id, stray.id)).toMatchObject({ ok: true });
  expect(found()).toBe(0);
});

test("the route deletes it, and says why when it will not", async () => {
  const t = setup("md-msgdel-route-");
  const hono = new Hono();
  mountAgentsRoutes(hono, { agentStore: t.store, messageDeletion: t.deletion } as never);
  const answered = t.say("Start the report");
  t.reply("On it.");
  const stray = t.say("waf");
  const path = (id: string) => `/api/agents/threads/${t.thread.id}/messages/${id}`;
  const refused = await deleteJson(hono, path(answered.id));
  expect([refused.status, refused.body]).toEqual([409, { error: ANSWERED }]);
  const done = await deleteJson(hono, path(stray.id));
  expect([done.status, done.body]).toEqual([200, { ok: true, removed: [stray.id] }]);
  expect((await deleteJson(hono, path(stray.id))).status).toBe(404);
});

test("what the runtime writes for the model alone is not a message that came in: a reply after it still answers", () => {
  for (const source of ["plan-reminder", "output-limit"] as const) {
    const t = setup(`md-msgdel-${source}-`);
    const asked = t.say("Start the report");
    t.context();
    t.unseen(source);
    t.reply("On it.");
    expect(t.deletion.delete(t.thread.id, asked.id)).toEqual({ ok: false, status: 409, error: ANSWERED });
    expect(t.store.getMessageById(asked.id) !== null).toBe(true);
    env?.cleanup();
    env = null;
  }
});

test("what the owner gave elsewhere came in after it: the reply answers that, and the message can go", () => {
  const t = setup("md-msgdel-pageinput-");
  const stray = t.say("waf");
  t.unseen("page-input");
  t.reply("Noted, the form is in.");
  expect(t.deletion.delete(t.thread.id, stray.id)).toMatchObject({ ok: true });
});

test("a page that was not listening is told at its next read on from where it was, a thread's and a worker's", async () => {
  const t = setup("md-msgdel-told-");
  const hono = new Hono();
  mountAgentsRoutes(hono, {
    agentStore: t.store, messageDeletion: t.deletion,
    scopes: { worker: stub<ScopeRuntime>({ verifyScopeId: (id: string | null) => (id === "f1" ? null : "worker not found") }) }
  } as never);
  const first = t.say("Start the report");
  t.reply("On it.");
  const stray = t.say("waf");
  t.context();
  const failure = t.failed();
  const worker = t.store.getOrCreateThread("worker", "f1");
  const typed = t.store.appendMessage({ threadId: worker.id, role: "user", source: "user", content: { type: "text", text: "wrong pane" } });
  const since = (path: string) => getJson(hono, `${path}?since=${first.seq}`);
  const threadPath = `/api/agents/threads/${t.thread.id}`;
  const workerPath = "/api/agents/workers/f1/thread";
  // Nothing deleted: nothing said.
  expect("deleted" in (await since(threadPath)).body).toBe(false);
  expect(t.deletion.delete(t.thread.id, stray.id)).toMatchObject({ ok: true });
  expect(t.deletion.delete(worker.id, typed.id)).toMatchObject({ ok: true });
  // Each read is told of its own thread's, the line that went with one too.
  expect((await since(threadPath)).body.deleted).toEqual([stray.id, failure.id]);
  expect((await since(workerPath)).body.deleted).toEqual([typed.id]);
  // A first page holds the rows as they are: there is nothing to tell it.
  expect("deleted" in (await getJson(hono, threadPath)).body).toBe(false);
  expect("deleted" in (await getJson(hono, workerPath)).body).toBe(false);
});

test("that a message was deleted is kept for 30 days", () => {
  let now = Date.parse("2026-03-01T00:00:00.000Z");
  const t = setup("md-msgdel-kept-", () => false, () => now);
  const early = t.say("waf");
  expect(t.deletion.delete(t.thread.id, early.id)).toMatchObject({ ok: true });
  now += 29 * 24 * 3_600_000;
  const later = t.say("wfa");
  expect(t.deletion.delete(t.thread.id, later.id)).toMatchObject({ ok: true });
  expect(t.deletion.deletedIn(t.thread.id)).toEqual([early.id, later.id]);
  now += 2 * 24 * 3_600_000;
  const last = t.say("awf");
  expect(t.deletion.delete(t.thread.id, last.id)).toMatchObject({ ok: true });
  expect(t.deletion.deletedIn(t.thread.id)).toEqual([later.id, last.id]);
});

test("a side chat's row in the list follows a deletion: its title was the deleted message's first line", async () => {
  const t = setup("md-msgdel-sidechat-");
  const chat = t.store.getOrCreateThread("side_chat", "sc_1");
  const published: string[] = [];
  const sinks: Array<(e: { event: string; data: unknown }) => void> = [];
  const stop = startSideChatBroadcast({
    sse: { addSink: (sink: (e: { event: string; data: unknown }) => void) => { sinks.push(sink); return () => {}; } } as never,
    service: { publish: (id: string) => { published.push(id); } } as never,
    agentStore: t.store
  });
  const typed = t.store.appendMessage({ threadId: chat.id, role: "user", source: "user", content: { type: "text", text: "Compare the two" } });
  const deletion = new MessageDeletion({
    db: t.env.store.db, agentStore: t.store, isRunning: () => false,
    sse: { emit: (event: string, data: unknown) => { for (const sink of sinks) sink({ event, data }); } } as never
  });
  expect(deletion.delete(chat.id, typed.id)).toMatchObject({ ok: true });
  // A manager thread's deletion is not a side chat's.
  const stray = t.say("waf");
  expect(deletion.delete(t.thread.id, stray.id)).toMatchObject({ ok: true });
  await Promise.resolve();
  expect(published).toEqual([chat.id]);
  stop();
});

test("a deleted message's place in the order is not given to the next one: a page that had read up to it is sent what came after", async () => {
  const t = setup("md-msgdel-seq-");
  const hono = new Hono();
  mountAgentsRoutes(hono, { agentStore: t.store, messageDeletion: t.deletion } as never);
  t.say("Start the report");
  t.reply("On it.");
  const stray = t.say("waf");
  const failure = t.failed();
  // A page that held both rows had read the thread up to the failure's line.
  const tip = failure.seq;
  expect(t.deletion.delete(t.thread.id, stray.id)).toEqual({ ok: true, removed: [stray.id, failure.id] });
  const again = t.say("Try again");
  const answer = t.reply("Trying.");
  expect([again.seq, answer.seq]).toEqual([tip + 1, tip + 2]);
  const read = await getJson(hono, `/api/agents/threads/${t.thread.id}?since=${tip}`);
  expect(read.body.messages.map((m: { id: string }) => m.id)).toEqual([again.id, answer.id]);
  expect(read.body.deleted).toEqual([stray.id, failure.id]);
  // One deleted from the middle moves nothing.
  const middle = t.say("wfa");
  const last = t.say("And the appendix");
  expect(t.deletion.delete(t.thread.id, middle.id)).toMatchObject({ ok: true });
  expect(t.say("And the index").seq).toBe(last.seq + 1);
});
