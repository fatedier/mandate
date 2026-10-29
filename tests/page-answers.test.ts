import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import type { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { PageAnswers, pageClock } from "../src/server/modules/page/page-answers.js";
import { mountPageRoutes } from "../src/server/modules/page/page-routes.js";
import { API_ROUTES, type SseEvent } from "../src/shared/api-contracts.js";

let env: StoresEnv | null = null;
let runtime: ReturnType<typeof buildAgentRuntime> | null = null;
afterEach(() => { runtime?.dispose(); runtime = null; env?.cleanup(); env = null; });

function setup() {
  env = freshStoresEnv("md-page-answers-");
  const events: SseEvent[] = [];
  const sse = { emit: (event: string, data: unknown) => { events.push({ event, data } as SseEvent); } };
  const store = new PageStore(env.store.db);
  const answers = new PageAnswers({ store, agentStore: env.agentStore, sse });
  const app = new Hono();
  mountPageRoutes(app, { pageStore: store, answers });
  const post = (body: string) => app.request(API_ROUTES.agentPageAnswers, { method: "POST", headers: { "content-type": "application/json" }, body });
  return { store, answers, app, post, events, sse };
}

test("an answer is kept, reaches Your agent quietly on its next wake, and reads as read after", async () => {
  const s = setup();
  const res = await s.post(JSON.stringify({ value: { pick: "c" } }));
  expect(res.status).toBe(200);
  const { answer } = await res.json() as { answer: { id: string; value: unknown; at: string; read: boolean } };
  expect(answer).toMatchObject({ value: { pick: "c" }, read: false });
  const global = env!.agentStore.getOrCreateGlobalThread();
  const rows = env!.store.db.prepare("select source, content, trigger_turn from agent_mailbox where thread_id = ?").all(global.id) as Array<{ source: string; content: string; trigger_turn: number }>;
  expect(rows.map((r) => [r.source, r.trigger_turn, JSON.parse(r.content).text])).toEqual([["page-input", 0, `[Page answer, ${pageClock(answer.at)}] {"pick":"c"}`]]);
  expect(env!.store.db.prepare("select count(*) as n from agent_wakes").get()).toEqual({ n: 0 });
  expect(s.events.filter((e) => e.event === "agentPageAnswer").map((e) => (e.data as { answer: { read: boolean } }).answer.read)).toStrictEqual([false]);

  // Your agent's next wake takes it in: it reads as read, and the page hears so.
  runtime = testAgentRuntime(env!, { page: { dir: "/nonexistent/page", publisher: { afterAgentTurn: () => {}, afterSubagent: () => false, writeStarted: () => {} }, answers: s.answers } });
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  const wake = env!.agentStore.createWake({ threadId: global.id, reason: "user", triggerMessageId: null });
  await deps.preWakeHook!(global.id, stub<Parameters<NonNullable<typeof deps.preWakeHook>>[1]>({ wakeId: wake.id, reason: "user" }));
  expect(env!.agentStore.getMessages(global.id).map((m) => m.source)).toEqual(["page-input"]);
  expect(s.answers.list(50)).toEqual([{ ...answer, read: true }]);
  expect(s.events.filter((e) => e.event === "agentPageAnswer").map((e) => (e.data as { answer: { read: boolean } }).answer.read)).toStrictEqual([false, true]);
});

test("answers are listed newest first, as the answers source reads them", async () => {
  const s = setup();
  for (const pick of ["a", "b", "c"]) s.answers.add({ pick });
  expect(s.answers.list(2).map((a) => a.value)).toStrictEqual([{ pick: "c" }, { pick: "b" }]);
});

test("an answer over 8 KB or not JSON is refused", async () => {
  const s = setup();
  expect((await s.post(JSON.stringify({ value: "x".repeat(8_200) }))).status).toBe(413);
  // Counted in bytes: 4,096 two-byte characters plus the quotes are over.
  expect((await s.post(JSON.stringify({ value: "é".repeat(4_096) }))).status).toBe(413);
  expect((await s.post(JSON.stringify({ value: "é".repeat(4_000) }))).status).toBe(200);
  expect((await s.post("{ not json"))).toMatchObject({ status: 400 });
  expect((await s.post(JSON.stringify({ other: 1 }))).status).toBe(400);
  expect((await s.post("x".repeat(100_000))).status).toBe(413);
  expect(env!.store.db.prepare("select count(*) as n from agent_page_answers").get()).toEqual({ n: 1 });
});

test("answers waiting for Your agent are capped: a page cannot flood its next turn", async () => {
  const s = setup();
  for (let i = 0; i < 20; i += 1) expect((await s.post(JSON.stringify({ value: i }))).status).toBe(200);
  const over = await s.post(JSON.stringify({ value: 20 }));
  expect(over.status).toBe(429);
  expect(await over.json()).toEqual({ error: "20 answers are waiting for Your agent already" });
  // Once Your agent read them, the page may answer again.
  const ids = env!.store.db.prepare("select mailbox_id from agent_page_answers").all() as Array<{ mailbox_id: string }>;
  s.store.markDelivered(ids.map((r) => r.mailbox_id));
  expect((await s.post(JSON.stringify({ value: 21 }))).status).toBe(200);
});

// Its note was taken in by one write and the answer marked read by the next:
// a refused second write left an answer that reached Your agent unread for
// good, counting toward the cap until the page could answer no more.
test("an answer's note and its read mark go in together: a refused mark leaves both for the next drain", async () => {
  const s = setup();
  const res = await s.post(JSON.stringify({ value: { pick: "c" } }));
  const { answer } = await res.json() as { answer: { id: string } };
  const global = env!.agentStore.getOrCreateGlobalThread();
  runtime = testAgentRuntime(env!, { page: { dir: "/nonexistent/page", publisher: { afterAgentTurn: () => {}, afterSubagent: () => false, writeStarted: () => {} }, answers: s.answers } });
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  const real = s.store.markDelivered.bind(s.store);
  let refuse = true;
  s.store.markDelivered = (ids) => {
    if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
    return real(ids);
  };
  const drain = async () => {
    const wake = env!.agentStore.createWake({ threadId: global.id, reason: "user", triggerMessageId: null });
    await deps.preWakeHook!(global.id, stub<Parameters<NonNullable<typeof deps.preWakeHook>>[1]>({ wakeId: wake.id, reason: "user" }));
  };
  await expect(drain()).rejects.toThrow("database is locked");
  expect(env!.agentStore.getMessages(global.id)).toEqual([]);
  expect(s.answers.list(50).map((a) => [a.id, a.read])).toEqual([[answer.id, false]]);
  expect(s.events.filter((e) => e.event === "agentPageAnswer")).toHaveLength(1);
  await drain();
  expect(env!.agentStore.getMessages(global.id).map((m) => m.source)).toEqual(["page-input"]);
  expect(s.answers.list(50).map((a) => [a.id, a.read])).toEqual([[answer.id, true]]);
  expect(s.events.filter((e) => e.event === "agentPageAnswer").map((e) => (e.data as { answer: { read: boolean } }).answer.read)).toStrictEqual([false, true]);
});
