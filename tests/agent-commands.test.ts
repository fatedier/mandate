import { expect, test } from "bun:test";
import { Hono } from "hono";
import { mountAgentsRoutes } from "../src/server/modules/agent/agents-api.js";
import {
  listAgentCommands, parseCommandDraft, runAgentCommand, type CommandHost
} from "../src/server/modules/agent/commands.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import type { ScopeRuntime } from "../src/server/runtime/scope.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";

/** A host whose every door is shut unless the test opens it: a command that
 *  reaches one it should not have fails the test. */
const host = (open: Partial<CommandHost> = {}): CommandHost => ({
  compact: () => { throw new Error("compact was not expected"); },
  compacting: () => false,
  stop: () => { throw new Error("stop was not expected"); },
  contextUsage: () => { throw new Error("contextUsage was not expected"); },
  ...open
});
const run = (text: string, open: Partial<CommandHost> = {}, attachments = 0) => runAgentCommand({ text, attachments }, host(open));

test("a draft is a command only when its first word is exactly a command's name", () => {
  const named = (text: string) => parseCommandDraft(text)?.command.name ?? null;
  expect(["/compact", "  /compact  ", "/stop", "/context", "/compact now", "/compact\nnow"].map(named))
    .toEqual(["/compact", "/compact", "/stop", "/context", "/compact", "/compact"]);
  // Paths and near-misses are what people write to an agent: ordinary messages.
  expect(["/tmp/foo is broken", "/Users/user/x", "/compactfoo", "/", "/Compact", "compact", "say /compact", ""].map(named))
    .toEqual([null, null, null, null, null, null, null, null]);
  expect(parseCommandDraft("/compact  keep the migration  ")?.rest).toBe("keep the migration");
});

test("the list a composer is given: three commands, each with the states it cannot run in", () => {
  expect(listAgentCommands()).toEqual([
    { name: "/compact", description: "Summarize earlier messages to free up context", blocked: { running: "A turn is running", compacting: "Already compacting" } },
    { name: "/stop", description: "Stop the running turn", blocked: { idle: "Nothing is running", compacting: "A compaction can't be stopped" } },
    { name: "/context", description: "Show how much context is in use", blocked: {} }
  ]);
});

test("/compact: starts, or says why not; only a refusal leaves the draft", () => {
  expect(run("/compact", { compact: () => "started" })).toEqual({ taken: true, message: null });
  expect(run("/compact", { compact: () => "nothing" })).toEqual({ taken: true, message: "Nothing to compact yet." });
  expect(run("/compact", { compact: () => "running" })).toEqual({ taken: false, message: "A turn is running. Try again when it finishes." });
  expect(run("/compact", { compact: () => "compacting" })).toEqual({ taken: false, message: "Already compacting." });
});

test("/stop: stops the running turn, and otherwise says what there is", () => {
  expect(run("/stop", { stop: () => true })).toEqual({ taken: true, message: null });
  expect(run("/stop", { stop: () => false })).toEqual({ taken: true, message: "Nothing is running." });
  expect(run("/stop", { stop: () => false, compacting: () => true })).toEqual({ taken: true, message: "A compaction can't be stopped once it has started." });
});

test("/context: the measured size, or that nothing has measured it", () => {
  const usage = (inputTokens: number | null, sinceCompaction = false) => ({ contextUsage: () => ({ inputTokens, budgetTokens: 250_000, sinceCompaction }) });
  expect(run("/context", usage(34_200))).toEqual({ taken: true, message: "Context: 34.2k of 250.0k tokens" });
  expect(run("/context", usage(null, true))).toEqual({ taken: true, message: "Not measured since the compaction. The next reply measures it." });
  expect(run("/context", usage(null))).toEqual({ taken: true, message: "Not measured yet. The next reply measures it." });
  expect(run("/context", { contextUsage: () => null })).toEqual({ taken: true, message: "Not measured yet. The next reply measures it." });
});

test("text or attachments after a command are refused before anything runs, naming the command", () => {
  // The host's doors are shut: reaching one would throw.
  expect(run("/compact keep the migration")).toEqual({ taken: false, message: "/compact takes no text after it." });
  expect(run("/stop now")).toEqual({ taken: false, message: "/stop takes no text after it." });
  expect(run("/context", {}, 2)).toEqual({ taken: false, message: "/context takes no attachments." });
  expect(run("/tmp/foo is broken")).toBe(null);
});

function app(env: ReturnType<typeof freshAgentEnv>, opts: { running?: { id: string } | null; budget?: number; compacting?: () => boolean } = {}) {
  const seen = { wakes: 0, canceled: [] as string[], compacted: [] as string[] };
  const queue = new AgentUserMessageQueue({
    agentStore: env.agentStore,
    sse: { emit: () => {} },
    wakeScheduler: { wake: () => { seen.wakes += 1; return "wake-1"; }, isThreadBusy: () => false }
  });
  const hono = new Hono();
  mountAgentsRoutes(hono, {
    agentStore: env.agentStore,
    wakeScheduler: {
      wake: () => { seen.wakes += 1; return "wake-1"; },
      getRunningWakeForThread: () => opts.running ?? null,
      cancelWake: (wakeId) => { seen.canceled.push(wakeId); return { ok: true, wakeId, status: "canceled" }; }
    },
    userMessageQueue: queue,
    contextBudgetTokens: opts.budget,
    compaction: { start: (threadId) => { seen.compacted.push(threadId); return "started"; }, inFlight: () => opts.compacting?.() ?? false },
    scopes: {
      manager: stub<ScopeRuntime>({ verifyScopeId: () => null }),
      worker: stub<ScopeRuntime>({ verifyScopeId: (id: string | null) => (id === "f1" ? null : "feature not found") }),
      global: stub<ScopeRuntime>({ verifyScopeId: () => null }),
      subagent: stub<ScopeRuntime>({ verifyScopeId: () => "a subagent's thread is read by its id" })
    }
  });
  const post = (path: string, body: unknown) => hono.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { hono, seen, queue, post };
}

test("a read of a thread says whether a compaction started by hand is in flight: its page, what came since, a worker's", async () => {
  const env = freshAgentEnv("md-commands-read-compacting-");
  let compacting = true;
  const a = app(env, { compacting: () => compacting });
  const thread = env.agentStore.createManagerThread("Release");
  env.agentStore.getOrCreateThread("worker", "f1");
  const paths = [`/api/agents/threads/${thread.id}`, `/api/agents/threads/${thread.id}?since=0`, "/api/agents/workers/f1/thread", "/api/agents/workers/f1/thread?since=0"];
  const read = async () => Promise.all(paths.map(async (path) => ((await (await a.hono.request(path)).json()) as { compacting?: boolean }).compacting));
  expect(await read()).toEqual([true, true, true, true]);
  compacting = false;
  expect(await read()).toEqual([false, false, false, false]);
});

test("a thread's command routes: the list, a run, and nothing a message would leave", async () => {
  const env = freshAgentEnv("md-commands-thread-");
  const a = app(env, { running: { id: "wake_running" }, budget: 250_000 });
  const thread = env.agentStore.createManagerThread("Release");
  const base = `/api/agents/threads/${thread.id}/commands`;

  const list = await a.hono.request(base);
  expect(list.status).toBe(200);
  expect(((await list.json()) as { commands: Array<{ name: string }> }).commands.map((c) => c.name)).toEqual(["/compact", "/stop", "/context"]);

  const compact = await a.post(base, { text: "/compact", attachments: 0 });
  expect([compact.status, await compact.json()]).toEqual([200, { taken: true, message: null }]);
  expect(a.seen.compacted).toStrictEqual([thread.id]);

  const stop = await a.post(base, { text: "/stop", attachments: 0 });
  expect(await stop.json()).toEqual({ taken: true, message: null });
  expect(a.seen.canceled).toStrictEqual(["wake_running"]);

  const context = await a.post(base, { text: "/context", attachments: 0 });
  expect(await context.json()).toEqual({ taken: true, message: "Not measured yet. The next reply measures it." });

  // A refusal is an answer, not an error.
  const refused = await a.post(base, { text: "/compact now", attachments: 0 });
  expect([refused.status, await refused.json()]).toEqual([200, { taken: false, message: "/compact takes no text after it." }]);

  // Not a message: no row, no queued message, no wake.
  expect(env.agentStore.getMessages(thread.id)).toEqual([]);
  expect(a.queue.pendingCount(thread.id)).toBe(0);
  expect(a.seen.wakes).toBe(0);

  // An ordinary draft does not belong here, and an unknown thread is not found.
  expect((await a.post(base, { text: "/tmp/foo is broken", attachments: 0 })).status).toBe(400);
  expect((await a.post(base, {})).status).toBe(400);
  expect((await a.post("/api/agents/threads/thr_missing/commands", { text: "/stop", attachments: 0 })).status).toBe(404);
  expect((await a.hono.request("/api/agents/threads/thr_missing/commands")).status).toBe(404);

  // The global agent's conversation is addressed the same way.
  const global = env.agentStore.getOrCreateThread("global", null);
  expect((await a.hono.request(`/api/agents/threads/${global.id}/commands`)).status).toBe(200);
  expect(await (await a.post(`/api/agents/threads/${global.id}/commands`, { text: "/context", attachments: 0 })).json())
    .toEqual({ taken: true, message: "Not measured yet. The next reply measures it." });
  // An archived thread is not open: it has no composer to run a command from.
  env.agentStore.archiveThread(thread.id);
  expect((await a.post(base, { text: "/stop", attachments: 0 })).status).toBe(404);
});

test("/context on a thread a call has measured, and after a compaction", async () => {
  const env = freshAgentEnv("md-commands-context-");
  const a = app(env, { budget: 250_000 });
  const thread = env.agentStore.createManagerThread("Measured");
  const wake = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  env.agentStore.updateWakeTokenUsage(wake.id, 34_200, 34_200);
  env.agentStore.finishWake(wake.id, "finished");
  const base = `/api/agents/threads/${thread.id}/commands`;
  expect(await (await a.post(base, { text: "/context", attachments: 0 })).json()).toEqual({ taken: true, message: "Context: 34.2k of 250.0k tokens" });

  await new Promise((resolve) => setTimeout(resolve, 2));
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "compression", content: { type: "summary", summary: "s", replacedRange: [1, 1], replacedCount: 1, retained: [] } });
  expect(await (await a.post(base, { text: "/context", attachments: 0 })).json()).toEqual({ taken: true, message: "Not measured since the compaction. The next reply measures it." });
});

test("a worker's command routes, also before anyone has written to it", async () => {
  const env = freshAgentEnv("md-commands-worker-");
  const a = app(env, { budget: 250_000 });
  const base = "/api/agents/workers/f1/commands";
  expect((await a.hono.request(base)).status).toBe(200);
  // No conversation yet: nothing to compact, nothing running, nothing measured; and none is created.
  expect(await (await a.post(base, { text: "/compact", attachments: 0 })).json()).toEqual({ taken: true, message: "Nothing to compact yet." });
  expect(await (await a.post(base, { text: "/stop", attachments: 0 })).json()).toEqual({ taken: true, message: "Nothing is running." });
  expect(await (await a.post(base, { text: "/context", attachments: 0 })).json()).toEqual({ taken: true, message: "Not measured yet. The next reply measures it." });
  expect(a.seen.compacted).toStrictEqual([]);
  expect(env.agentStore.getThreadByScope("worker", "f1")).toBe(null);

  // Once it has one, the command reaches it.
  const thread = env.agentStore.getOrCreateThread("worker", "f1");
  await a.post(base, { text: "/compact", attachments: 0 });
  expect(a.seen.compacted).toStrictEqual([thread.id]);

  expect((await a.hono.request("/api/agents/workers/f_missing/commands")).status).toBe(404);
  expect((await a.post("/api/agents/workers/f_missing/commands", { text: "/stop", attachments: 0 })).status).toBe(404);
});
