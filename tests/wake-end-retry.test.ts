import { expect, spyOn, test } from "bun:test";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";

// The database can refuse the write that ends a turn: an outside writer (an
// agent running sqlite3 on Mandate's database) holding it past the busy
// timeout. The turn then stayed "running" with nothing left to end it, and
// the failure surfaced as an unhandled rejection.

const STUB_SCOPE = (_t: string): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const DISPATCH: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };

function fresh() {
  const store = new MandateStore(tempDir("md-wake-end-"));
  onCleanup(() => store.db.close());
  return new AgentStore(store.db);
}

/** finishWake refused `refusals` times, as SQLite refuses a locked database;
 *  `onRefuse` runs at each refusal (a person pressing Stop meanwhile). */
function refuseFinish(agentStore: AgentStore, refusals: number, onRefuse?: (wakeId: string) => void) {
  const real = agentStore.finishWake.bind(agentStore);
  let left = refusals;
  const finish = spyOn(agentStore, "finishWake").mockImplementation((...args: Parameters<AgentStore["finishWake"]>) => {
    if (left > 0) {
      left--;
      onRefuse?.(args[0]);
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return real(...args);
  });
  onCleanup(() => finish.mockRestore());
  return finish;
}

async function runWake(
  agentStore: AgentStore,
  turns: Parameters<typeof createMockLLM>[0] = [{ text: "Done.", finishReason: "stop" }],
  hooks: { scheduler?: { cancelWake(wakeId: string): unknown }; ended?: string[] } = {}
) {
  const thread = agentStore.getOrCreateThread("worker", `feat-${Math.random().toString(36).slice(2)}`);
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const events: Array<{ name: string; data: { status?: string } }> = [];
  const lock = new WakeLock();
  const { wakeAndWait, scheduler } = createTestWakeScheduler({
    agentStore, lock,
    postWakeHook: (_threadId, info) => { hooks.ended?.push(info.status); },
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => DISPATCH,
    llmModel: createMockLLM(turns),
    sse: { emit: (name, data) => events.push({ name, data: data as { status?: string } }) },
    buildToolScope: STUB_SCOPE,
    wakeEndRetryDelaysMs: [1, 1, 1, 1]
  });
  hooks.scheduler = scheduler;
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  return { thread, wakeId, events, lock };
}

test("a turn whose end the database refuses for a while still ends: the row is finished and the page hears it once", async () => {
  const agentStore = fresh();
  const finish = refuseFinish(agentStore, 2);
  const { wakeId, events } = await runWake(agentStore);
  expect(finish).toHaveBeenCalledTimes(3);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("finished");
  expect(events.filter((e) => e.name === "agentWakeFinished").map((e) => e.data.status)).toStrictEqual(["finished"]);
});

test("a turn that failed, whose end the database refuses for a while, still ends as failed with one failure row", async () => {
  const agentStore = fresh();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  onCleanup(() => logged.mockRestore());
  refuseFinish(agentStore, 2);
  const { thread, wakeId, events } = await runWake(agentStore, [{ error: "primary unavailable" }]);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("error");
  expect(agentStore.getMessages(thread.id).filter((m) => m.content.type === "wake_failure")).toHaveLength(1);
  expect(events.filter((e) => e.name === "agentWakeFinished").map((e) => e.data.status)).toStrictEqual(["error"]);
});

// Stop pressed while the end waits for the database: accepted, so the turn
// ends stopped, not as it would have ended — a stopped worker reports nothing.
test("Stop accepted while a turn's end waits for the database ends it stopped", async () => {
  const agentStore = fresh();
  const hooks: { scheduler?: { cancelWake(wakeId: string): unknown }; ended: string[] } = { ended: [] };
  const answers: unknown[] = [];
  refuseFinish(agentStore, 1, (wakeId) => answers.push(hooks.scheduler!.cancelWake(wakeId)));
  const { wakeId, events } = await runWake(agentStore, undefined, hooks);
  expect(answers).toStrictEqual([{ ok: true, wakeId, status: "running" }]);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("canceled");
  expect(events.filter((e) => e.name === "agentWakeFinished").map((e) => e.data.status)).toStrictEqual(["canceled"]);
  expect(hooks.ended).toEqual(["canceled"]);
});

test("a turn whose end the database keeps refusing is logged, not thrown, and its thread is let go", async () => {
  const agentStore = fresh();
  const finish = refuseFinish(agentStore, Number.POSITIVE_INFINITY);
  const logged = spyOn(console, "error").mockImplementation(() => {});
  onCleanup(() => logged.mockRestore());
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  onCleanup(() => process.off("unhandledRejection", onUnhandled));

  const { thread, lock } = await runWake(agentStore);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Five tries in all; then the log says so, and nothing escapes.
  expect(finish).toHaveBeenCalledTimes(5);
  expect(unhandled).toStrictEqual([]);
  expect(logged.mock.calls.some((call) => String(call[0]).includes("could not be ended"))).toBe(true);
  // The thread is not held: Stop, or the next start, closes the row.
  expect(lock.isHeld(thread.id)).toBe(false);
});

// A wake takes its thread, then writes its row. When the database refused the
// row, the thread stayed taken: every later message queued behind a wake that
// never existed, and Stop (which goes by a wake's row) could not free it.
test("a wake whose row the database refuses lets go of its thread, so the next wake starts", async () => {
  const store = new MandateStore(tempDir("md-wake-start-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.getOrCreateThread("worker", "feat-start");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const real = agentStore.createWake.bind(agentStore);
  let refuse = true;
  const create = spyOn(agentStore, "createWake").mockImplementation((...args: Parameters<AgentStore["createWake"]>) => {
    if (refuse) {
      refuse = false;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return real(...args);
  });
  onCleanup(() => create.mockRestore());
  const lock = new WakeLock();
  const { scheduler, wakeAndWait } = createTestWakeScheduler({
    agentStore, lock,
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => DISPATCH,
    llmModel: createMockLLM([{ text: "Done.", finishReason: "stop" }]),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE
  });
  // The caller hears the refusal, as before.
  expect(() => scheduler.wake(thread.id, "user", ask.id)).toThrow("database is locked");
  expect(lock.isHeld(thread.id)).toBe(false);
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("finished");
});
