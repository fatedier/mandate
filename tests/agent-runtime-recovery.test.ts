import { expect, test } from "bun:test";
import { loadConfig } from "../src/server/config.js";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS } from "../src/server/runtime/manager-work-item-heartbeat.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";

test("runtime resumes a manager sweep and schedules its next sweep after releasing the wake", async () => {
  const env = freshStoresEnv("md-runtime-recovery-");
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  let resolveReleased!: () => void;
  const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  const timeouts: Array<{ handle: ReturnType<typeof setTimeout>; ms: unknown }> = [];
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realTimeout(...args);
    timeouts.push({ handle, ms: args[1] });
    return handle;
  }) as typeof setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realInterval(...args);
    intervals.push(handle);
    return handle;
  }) as typeof setInterval;
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const original = env.agentStore.createWake({ threadId: thread.id, reason: "work-item-heartbeat", triggerMessageId: null });
    runtime = buildAgentRuntime({
      config: loadConfig(env.dir), ready, store: env.store, agentStore: env.agentStore,
      projectsStore: env.projects, featuresStore: env.features,
      workStore: new WorkItemStore(env.store.db), canvasStore: new CanvasStore(env.store.db, env.dir),
      analyzer: new Analyzer(), skillRegistry: new SkillRegistry(),
      sse: { emit: () => {} } as never, publishLifecycle: () => {}, getSnapshot: () => null,
      tmuxClient: {} as never, gitClient: {} as never, paneRuntimes: {} as never
    });
    // Keep the real startup, mailbox and lifecycle hooks. Only replace model
    // and prompt providers, so this test never contacts an external service.
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const model = createMockLLM([{ text: "The worker is still running; check again on the next sweep." }]);
    deps.llmForThread = () => ({ model });
    deps.llmCallRecorder = undefined;
    deps.buildSystemPrompt = () => "test";
    deps.buildRuntimeContext = () => null;
    deps.buildInitialContext = () => null;
    deps.beforeModelCallHook = undefined;
    const afterRelease = deps.afterWakeReleasedHook;
    deps.afterWakeReleasedHook = async (threadId) => {
      await afterRelease?.(threadId);
      resolveReleased();
    };
    expect(model.callsMade).toBe(0);
    resolveReady();
    await released;
    expect(model.callsMade).toBe(1);
    expect(env.agentStore.getWakeById(original.id)?.status).toBe("error");
    expect(env.agentStore.getRunningWakeForThread(thread.id)).toBeNull();
    expect(timeouts.filter((timer) => timer.ms === DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS)).toHaveLength(1);
  } finally {
    runtime?.dispose();
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
    for (const timer of timeouts) clearTimeout(timer.handle);
    for (const timer of intervals) clearInterval(timer);
    env.cleanup();
  }
});
