import { expect, test } from "bun:test";
import { WakeRuntimeContext } from "../src/server/modules/agent/wake-runtime-context.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";

// A turn updates its runtime context once at most (its prompt cache stays
// steady). A thread whose context only reads is not built again in a turn
// that has updated it: nothing could come of it. One whose build changes
// state (the personal agent's ends waits on what is gone) is built at every step.

let env: StoresEnv | null = null;

function setup(readsOnly: boolean) {
  env = freshStoresEnv("md-runtime-context-reads-");
  const e = env;
  let builds = 0;
  const context = new WakeRuntimeContext({
    agentStore: e.agentStore,
    buildSystemPrompt: () => "SYSTEM",
    buildRuntimeContext: () => { builds += 1; return `state ${builds}`; },
    contextReadsOnly: () => readsOnly
  });
  const thread = e.agentStore.getOrCreateThread("worker", "wkr-context");
  const wake = e.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  context.begin(wake.id);
  const step = () => context.ensurePromptContextMessages(thread.id, wake.id);
  const contexts = () => e.agentStore.getActiveMessages(thread.id).filter((m) => m.source === "runtime-context").length;
  return { e, thread, step, contexts, builds: () => builds };
}

test("a context that only reads is built once in a turn that updated it", async () => {
  const s = setup(true);
  await s.step();
  await s.step();
  await s.step();
  expect(s.builds()).toBe(1);
  expect(s.contexts()).toBe(1);
});

test("a context whose build changes state is built at every step, as before", async () => {
  const s = setup(false);
  await s.step();
  await s.step();
  await s.step();
  expect(s.builds()).toBe(3);
  expect(s.contexts()).toBe(1);
});

test("after a compaction in the turn the context is built and given again", async () => {
  const s = setup(true);
  await s.step();
  s.e.agentStore.appendMessage({
    threadId: s.thread.id, role: "user", source: "compression",
    content: { type: "summary", summary: "what came before", replacedRange: [1, 1], replacedCount: 1, compactedCount: 1, retained: [] }
  });
  await s.step();
  expect(s.builds()).toBe(2);
  expect(s.contexts()).toBe(1);
});
