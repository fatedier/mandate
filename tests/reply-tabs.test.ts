import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ReplyTabStore, mountReplyTabRoutes } from "../src/server/modules/agent/reply-tabs.js";
import { API_PATHS } from "../src/shared/api/routes.js";
import { MAX_REPLY_TAB_CHARS } from "../src/shared/api/reply-tabs.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { deleteJson, getJson, postJson } from "./helpers/test-app.js";

// A reply opened in the right panel is kept per thread on the server, so
// every device shows the same tabs; each change says so on the event stream.

function setup(prefix: string) {
  const env = freshStoresEnv(prefix);
  const agent = env.agentStore;
  const events: Array<{ event: string; data: unknown }> = [];
  const store = new ReplyTabStore(env.store.db);
  const app = new Hono();
  mountReplyTabRoutes(app, { store, agentStore: agent, sse: { emit: (event, data) => { events.push({ event, data }); } } });
  const thread = agent.createManagerThread("Release 3.21").id;
  const reply = (threadId: string, text: string) =>
    agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: "wake_1", content: { type: "assistant", text } });
  return { env, agent, store, app, events, thread, reply };
}

test("add, list and remove a reply tab, each change sending replyTabsChanged", async () => {
  const s = setup("md-reply-tabs-");
  const message = s.reply(s.thread, "**Release check**: two of three services are ready.");
  const added = await postJson(s.app, API_PATHS.agentThreadReplyTabs(s.thread), { messageId: message.id, text: "**Release check**: two of three services are ready." });
  expect(added.status).toBe(200);
  expect(added.body.tabs).toHaveLength(1);
  expect(added.body.tabs[0]).toMatchObject({ threadId: s.thread, messageId: message.id, text: "**Release check**: two of three services are ready.", repliedAt: message.createdAt });
  const listed = await getJson(s.app, API_PATHS.agentThreadReplyTabs(s.thread));
  expect(listed.body).toEqual(added.body);
  const removed = await deleteJson(s.app, API_PATHS.agentThreadReplyTab(s.thread, added.body.tabs[0].id));
  expect(removed).toEqual({ status: 200, body: { tabs: [] } });
  expect(s.events).toEqual([
    { event: SSE_EVENTS.replyTabsChanged, data: { threadId: s.thread } },
    { event: SSE_EVENTS.replyTabsChanged, data: { threadId: s.thread } }
  ]);
  expect((await deleteJson(s.app, API_PATHS.agentThreadReplyTab(s.thread, added.body.tabs[0].id))).status).toBe(404);
});

test("adding the same reply twice keeps one tab", async () => {
  const s = setup("md-reply-tabs-twice-");
  const message = s.reply(s.thread, "The migration ran on staging.");
  const first = await postJson(s.app, API_PATHS.agentThreadReplyTabs(s.thread), { messageId: message.id, text: "The migration ran on staging." });
  const second = await postJson(s.app, API_PATHS.agentThreadReplyTabs(s.thread), { messageId: message.id, text: "The migration ran on staging." });
  expect(second).toEqual(first);
  expect(s.events).toHaveLength(1);
});

test("refuses a message of another thread, a user message, empty or too long text, and other scopes", async () => {
  const s = setup("md-reply-tabs-refused-");
  const elsewhere = s.reply(s.agent.createManagerThread("Docs layout").id, "Another thread's reply.");
  const asked = s.agent.appendMessage({ threadId: s.thread, role: "user", source: "user", content: { type: "text", text: "What is left?" } });
  const message = s.reply(s.thread, "Billing waits on its migration.");
  const post = (threadId: string, body: unknown) => postJson(s.app, API_PATHS.agentThreadReplyTabs(threadId), body);
  expect((await post(s.thread, { messageId: elsewhere.id, text: "Another thread's reply." })).status).toBe(404);
  expect((await post(s.thread, { messageId: asked.id, text: "What is left?" })).status).toBe(404);
  expect((await post(s.thread, { messageId: message.id, text: "  \n " })).status).toBe(400);
  expect((await post(s.thread, { messageId: 42, text: "Billing waits on its migration." })).status).toBe(400);
  const tooLong = await post(s.thread, { messageId: message.id, text: "x".repeat(MAX_REPLY_TAB_CHARS + 1) });
  expect(tooLong).toEqual({ status: 400, body: { error: "text is longer than 200,000 characters" } });
  const workerId = seedWorker(s.env.workers, seedProject(s.env.projects));
  const worker = s.agent.getOrCreateThread("worker", workerId).id;
  const workerReply = s.reply(worker, "A worker's reply.");
  expect((await post(worker, { messageId: workerReply.id, text: "A worker's reply." })).status).toBe(404);
  expect((await getJson(s.app, API_PATHS.agentThreadReplyTabs(worker))).status).toBe(404);
  expect((await getJson(s.app, API_PATHS.agentThreadReplyTabs("thr_missing"))).status).toBe(404);
  expect(s.events).toStrictEqual([]);
  expect(s.store.list(s.thread)).toStrictEqual([]);
});

test("tabs list in the order added, on the personal agent's thread too", async () => {
  const s = setup("md-reply-tabs-order-");
  const personal = s.agent.getOrCreatePersonalThread().id;
  const later = s.reply(personal, "Second reply, written later.");
  const earlier = s.reply(personal, "First reply, opened second.");
  await postJson(s.app, API_PATHS.agentThreadReplyTabs(personal), { messageId: later.id, text: "Second reply, written later." });
  const both = await postJson(s.app, API_PATHS.agentThreadReplyTabs(personal), { messageId: earlier.id, text: "First reply, opened second." });
  expect(both.body.tabs.map((tab: { messageId: string }) => tab.messageId)).toEqual([later.id, earlier.id]);
});
