import { loadConfig } from "../../src/server/config.js";
import { buildAgentRuntime } from "../../src/server/runtime/agent-runtime.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import { CanvasStore } from "../../src/server/modules/canvas/canvas-store.js";
import { SkillRegistry } from "../../src/server/modules/skills/skill-registry.js";
import { Analyzer } from "../../src/server/modules/analysis/analyzer.js";
import type { AgentSseEmitter } from "../../src/server/modules/sse/sse-events.js";
import type { TmuxClient } from "../../src/server/platform/tmux/tmux.js";
import type { PaneRuntimeRegistry } from "../../src/server/runtime/pane-runtime-registry.js";
import type { freshStoresEnv } from "./fixtures.js";
import { stub } from "./typed.js";

type RuntimeDeps = Parameters<typeof buildAgentRuntime>[0];

/** The agent runtime over a test's stores, as the runtime-wiring tests build
 *  it: never ready (no start-up wake runs), a silent SSE, no tmux snapshot,
 *  and stubs for tmux, git and panes. `over` sets any of its deps. The test
 *  disposes it. */
export function testAgentRuntime(env: ReturnType<typeof freshStoresEnv>, over: Partial<RuntimeDeps> = {}): ReturnType<typeof buildAgentRuntime> {
  return buildAgentRuntime({
    config: loadConfig(env.dir), ready: new Promise(() => {}), store: env.store, agentStore: env.agentStore,
    projectsStore: env.projects, featuresStore: env.features,
    workStore: new WorkItemStore(env.store.db), canvasStore: new CanvasStore(env.store.db, env.dir),
    analyzer: new Analyzer(), skillRegistry: new SkillRegistry(),
    sse: stub<AgentSseEmitter>({ emit: () => {}, addSink: () => () => {} }), publishLifecycle: () => {}, getSnapshot: () => null,
    tmuxClient: stub<TmuxClient>(), gitClient: {}, paneRuntimes: stub<PaneRuntimeRegistry>(),
    ...over
  });
}
