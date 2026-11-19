import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { AppDeps } from "../app/deps.js";
import { activityModule } from "./activity/module.js";
import { agentModule } from "./agent/module.js";
import { personalModule } from "./personal/module.js";
import { pageModule } from "./page/module.js";
import { analysisModule } from "./analysis/module.js";
import { canvasModule } from "./canvas/module.js";
import { stateModule } from "./state/module.js";
import { workersModule } from "./workers/module.js";
import { gitModule } from "./git/module.js";
import { memoryModule } from "./memory/module.js";
import { webModule } from "./web/module.js";
import type {
  AgentScopePackContext,
  CommonToolPackContext,
  WorkerToolPackContext,
  MandateModule,
  ManagerToolPackContext
} from "./module.js";
import { panesModule } from "./panes/module.js";
import { plansModule } from "./plans/module.js";
import { pricingModule } from "./pricing/module.js";
import { projectsModule } from "./projects/module.js";
import { sessionsModule } from "./sessions/module.js";
import { settingsModule } from "./settings/module.js";
import { setupModule } from "./setup/module.js";
import { skillsModule } from "./skills/module.js";
import { sseModule } from "./sse/module.js";
import { voiceModule } from "./voice/module.js";
import { toolReviewModule } from "./tool-review/module.js";
import { notificationsModule } from "./notifications/module.js";
import { schedulesModule } from "./schedules/module.js";
import { taskBoardModule } from "./task-board/module.js";
import { stickyNotesModule } from "./sticky-notes/module.js";
import { calendarModule } from "./calendar/module.js";
import { sideChatModule } from "./side-chat/module.js";
import { filesModule } from "./files/module.js";

const MODULES: readonly MandateModule[] = [
  sseModule,
  projectsModule,
  workersModule,
  plansModule,
  gitModule,
  sessionsModule,
  skillsModule,
  agentModule,
  personalModule,
  pageModule,
  analysisModule,
  activityModule,
  pricingModule,
  stateModule,
  canvasModule,
  memoryModule,
  webModule,
  panesModule,
  voiceModule,
  toolReviewModule,
  notificationsModule,
  schedulesModule,
  taskBoardModule,
  stickyNotesModule,
  calendarModule,
  sideChatModule,
  filesModule,
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

export function moduleSkillAppendices(): ReadonlyMap<string, () => string> {
  const out = new Map<string, () => string>();
  for (const module of MODULES) {
    for (const [skill, appendix] of Object.entries(module.skillAppendices ?? {})) {
      if (out.has(skill)) throw new Error(`skill ${skill} has an appendix from more than one module`);
      out.set(skill, appendix);
    }
  }
  return out;
}
