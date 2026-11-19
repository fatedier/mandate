import { expect, test } from "bun:test";
import { Hono } from "hono";
import { CanvasStore } from "../../src/server/modules/canvas/canvas-store.js";
import { WorkersStore } from "../../src/server/modules/workers/workers-store.js";
import { buildTestScopes, getJson } from "../helpers/test-app.js";
import { freshAgentEnv, NOOP_WAKE } from "../helpers/fixtures.js";
import { stub } from "../helpers/typed.js";
import { mountAgentModuleRoutes } from "../../src/server/modules/agent/agent-routes.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import type { AppDeps } from "../../src/server/app/deps.js";
import type { Config } from "../../src/server/config.js";
import type { AgentSseEmitter } from "../../src/server/modules/sse/sse-events.js";

// A conversation's context meter, as a page load reads it, divides by the
// compression threshold the settings hold now. Saving the settings replaces
// the server's config in place; a page load that kept the number it read at
// start showed 108% while the turns' own updates showed 87%.
test("a thread read after the compression threshold was changed in the settings measures against the new threshold", async () => {
  const env = freshAgentEnv("md-budget-live-");
  const workers = new WorkersStore(env.store.db);
  const config = stub<Config>({ agent: stub<Config["agent"]>({ compressionThresholdTokens: 400_000 }) });
  const app = new Hono();
  mountAgentModuleRoutes(app, stub<AppDeps>({
    store: env.store, agentStore: env.agentStore, canvasStore: new CanvasStore(env.store.db, env.dir),
    workStore: new WorkItemStore(env.store.db), workers, wakeScheduler: NOOP_WAKE,
    scopes: buildTestScopes(workers), sse: stub<AgentSseEmitter>({ emit: () => {} }), config
  }));
  const thread = env.agentStore.createManagerThread("project-1 release notes");
  const wake = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  env.agentStore.updateWakeTokenUsage(wake.id, 433_652, 433_652);
  env.agentStore.finishWake(wake.id, "finished");
  const budget = async () => (await getJson(app, `/api/agents/threads/${thread.id}`)).body.contextUsage;
  expect(await budget()).toMatchObject({ inputTokens: 433_652, budgetTokens: 400_000 });
  // Saved in the settings: the same config object, its value replaced.
  config.agent.compressionThresholdTokens = 500_000;
  expect(await budget()).toMatchObject({ inputTokens: 433_652, budgetTokens: 500_000 });
});
