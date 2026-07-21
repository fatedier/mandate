import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { AppDeps } from "../app/deps.js";
import { activityModule } from "./activity/module.js";
import { agentModule } from "./agent/module.js";
import { analysisModule } from "./analysis/module.js";
import { canvasModule } from "./canvas/module.js";
import { stateModule } from "./state/module.js";
import { featuresModule } from "./features/module.js";
import { gitModule } from "./git/module.js";
import { memoryModule } from "./memory/module.js";
import type {
  AgentScopePackContext,
  CommonToolPackContext,
  WorkerToolPackContext,
  MandateModule,
  ManagerToolPackContext
} from "./module.js";
import { panesModule } from "./panes/module.js";
import { projectsModule } from "./projects/module.js";
import { sessionsModule } from "./sessions/module.js";
import { settingsModule } from "./settings/module.js";
import { setupModule } from "./setup/module.js";
import { skillsModule } from "./skills/module.js";
import { sseModule } from "./sse/module.js";
import { uiContextModule } from "./ui-context/module.js";
import { voiceModule } from "./voice/module.js";

const MODULES: readonly MandateModule[] = [
  sseModule,
  projectsModule,
  featuresModule,
  gitModule,
  sessionsModule,
  skillsModule,
  agentModule,
  analysisModule,
  activityModule,
  stateModule,
  canvasModule,
  memoryModule,
  panesModule,
  voiceModule,
  uiContextModule,
  setupModule,
  settingsModule
];

export function getMandateModules(): readonly MandateModule[] {
  return MODULES;
}

export function mountRegisteredModuleRoutes(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  deps: AppDeps
): void {
  const seen = new Set<string>();
  for (const module of MODULES) {
    if (seen.has(module.id)) {
      throw new Error(`duplicate module id: ${module.id}`);
    }
    seen.add(module.id);
    module.mountRoutes?.(app, { deps, upgradeWebSocket });
  }
}

export function buildCommonToolPacks(input: CommonToolPackContext) {
  return MODULES.flatMap((module) => module.commonToolPacks?.(input) ?? []);
}

export function buildWorkerToolPacks(input: WorkerToolPackContext) {
  return MODULES.flatMap((module) => module.workerToolPacks?.(input) ?? []);
}

export function buildManagerToolPacks(input: ManagerToolPackContext) {
  return MODULES.flatMap((module) => module.managerToolPacks?.(input) ?? []);
}

export function buildAgentScopePacks(input: AgentScopePackContext) {
  return MODULES.flatMap((module) => module.scopePacks?.(input) ?? []);
}
