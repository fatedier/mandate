import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.js";
import type { MandateStore } from "../app/store.js";
import type { AgentScope, AgentStore } from "./agent/agent-store.js";
import type { AgentUserMessageQueue } from "./agent/user-message-queue.js";
import type { AgentSseEmitter } from "./sse/sse-events.js";
import type { CanvasStore } from "./canvas/canvas-store.js";
import type { SkillRegistry } from "./skills/skill-registry.js";
import type { WakeScheduler } from "./agent/wake-loop.js";
import type { WindowWatchManager } from "./agent/window-watch-manager.js";
import type { SweepController } from "./agent/tools/sweep-tools.js";
import type { AgentAlarmManager } from "./agent/agent-alarm-manager.js";
import type { AppDeps } from "../app/deps.js";
import type { FeaturesStore } from "./features/features-store.js";
import type { MemoryManager } from "./memory/manager.js";
import type { ProjectsStore } from "./projects/projects-store.js";
import type { LifecyclePublisher } from "../runtime/events.js";
import type { PaneRuntimeRegistry } from "../runtime/pane-runtime-registry.js";
import type { PaneMetadataStore } from "./panes/pane-metadata-store.js";
import type { ScopePack } from "../runtime/scope-packs.js";
import type { WorkerScopeDeps } from "../runtime/scopes/worker-scope.js";
import type { ManagerScopeDeps } from "../runtime/scopes/manager-scope.js";
import type { ToolPack } from "../runtime/tool-packs.js";
import type { TmuxSnapshot } from "../platform/tmux/tmux-types.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { GitClient } from "../platform/git/git.js";
import type { UiContextRegistry } from "./ui-context/ui-context-registry.js";
import type { WorkItemStore } from "./agent/work-item-store.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";
import type { Migration } from "../platform/db/migrations.js";

interface ModuleRouteContext {
  deps: AppDeps;
  upgradeWebSocket: UpgradeWebSocket;
}

export interface CommonToolPackContext {
  scope: AgentScope;
  store?: MandateStore;
  agentStore?: AgentStore;
  projectsStore?: ProjectsStore;
  featuresStore?: FeaturesStore;
  workStore?: WorkItemStore;
  skillRegistry: SkillRegistry;
  uiContextRegistry?: UiContextRegistry;
  watchManager: WindowWatchManager;
  alarmManager?: AgentAlarmManager;
  sweepController?: SweepController;
  memory?: MemoryManager | null;
  canvasStore?: CanvasStore;
  sse?: AgentSseEmitter;
  getWakeScheduler?: () => WakeScheduler;
  userMessageQueue?: Pick<AgentUserMessageQueue, "submitThreadUserMessage">;
  markPendingTaskWake?: (threadId: string) => void;
  markPendingMailboxWake?: (threadId: string) => void;
  paneMetadata?: PaneMetadataStore;
  supportsInputForScope?: (scope: AgentScope, input: ModelInputType) => boolean;
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  supportsToolResultImagesForThread?: (threadId: string) => boolean;
}

export interface ManagerToolPackContext {
  config: Config;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  workStore: WorkItemStore;
  sessionDataDir?: string;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  paneRuntimes: PaneRuntimeRegistry;
  sse: AgentSseEmitter;
  publishLifecycle: LifecyclePublisher;
  getSnapshot: () => TmuxSnapshot | null;
  getWakeScheduler: () => WakeScheduler;
  beforeFeatureArchive?: (featureId: string) => void;
}

export interface AgentScopePackContext {
  worker: WorkerScopeDeps;
  manager: ManagerScopeDeps;
}

export interface WorkerToolPackContext {
  watchManager: WindowWatchManager;
}

type SchemaInitializer = (db: Database) => void;

export interface MandateModule {
  id: string;
  schema?: SchemaInitializer[];
  /** One-shot migrations for what convergent DDL cannot express. Run after all
   *  modules' schema initialisers, in registry order then array order. */
  migrations?: Migration[];
  mountRoutes?: (app: Hono, ctx: ModuleRouteContext) => void;
  commonToolPacks?: (ctx: CommonToolPackContext) => ToolPack[];
  workerToolPacks?: (ctx: WorkerToolPackContext) => ToolPack[];
  managerToolPacks?: (ctx: ManagerToolPackContext) => ToolPack[];
  scopePacks?: (ctx: AgentScopePackContext) => ScopePack[];
}
