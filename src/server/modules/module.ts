import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { MandateStore } from "../app/store.js";
import type { AgentScope, AgentStore } from "./agent/agent-store.js";
import type { AgentSseEmitter } from "./sse/sse-events.js";
import type { CanvasStore } from "./canvas/canvas-store.js";
import type { SkillRegistry } from "./skills/skill-registry.js";
import type { WakeScheduler } from "./agent/wake-loop.js";
import type { PaneMonitorManager } from "./agent/pane-monitor-manager.js";
import type { CommandMonitorManager } from "./agent/command-monitor-manager.js";
import type { SweepController } from "./agent/tools/sweep-tools.js";
import type { AgentAlarmManager } from "./agent/agent-alarm-manager.js";
import type { AppDeps } from "../app/deps.js";
import type { WorkersStore } from "./workers/workers-store.js";
import type { MemoryManager } from "./memory/manager.js";
import type { ProjectsStore } from "./projects/projects-store.js";
import type { LifecyclePublisher } from "../runtime/events.js";
import type { TmuxRuntime } from "../runtime/runtimes/tmux-runtime.js";
import type { ScopePack } from "../runtime/scope-packs.js";
import type { WorkerScopeDeps } from "../runtime/scopes/worker-scope.js";
import type { ManagerScopeDeps } from "../runtime/scopes/manager-scope.js";
import type { PersonalScopeDeps } from "./personal/personal-scope.js";
import type { PlanStore } from "./plans/plan-store.js";
import type { ToolPack } from "../runtime/tool-packs.js";
import type { TmuxSnapshot } from "../platform/tmux/tmux-types.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { GitClient } from "../platform/git/git.js";
import type { DutySummaryDto } from "../../shared/api/schedules.js";
import type { WorkItemStore } from "./agent/work-item-store.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";
import type { SchemaInitializer } from "../platform/db/schema.js";
import type { SubagentService } from "../runtime/subagents.js";
import type { BackgroundCommandService } from "../runtime/background-commands.js";
import type { TaskList } from "../runtime/task-list.js";
import type { ShellCommandRunner } from "../platform/process/shell-command-runner.js";
import type { SubagentScopeDeps } from "../runtime/scopes/subagent-scope.js";
import type { SideChatScopeDeps } from "./side-chat/side-chat-scope.js";
import type { ConversationScope } from "../../shared/api/agents.js";
import type { WebTools } from "./web/web-tools.js";

interface ModuleRouteContext {
  deps: AppDeps;
  upgradeWebSocket: UpgradeWebSocket;
}

export interface CommonToolPackContext {
  scope: AgentScope;
  store?: MandateStore;
  agentStore?: AgentStore;
  projectsStore?: ProjectsStore;
  workersStore?: WorkersStore;
  workStore?: WorkItemStore;
  skillRegistry: SkillRegistry;
  paneMonitorManager: PaneMonitorManager;
  commandMonitorManager?: CommandMonitorManager;
  alarmManager?: AgentAlarmManager;
  sweepController?: SweepController;
  memory?: MemoryManager | null;
  canvasStore?: CanvasStore;
  sse?: AgentSseEmitter;
  getWakeScheduler?: () => WakeScheduler;
  /** A worker wrote new questions into its plan: its manager is told now. */
  onWorkerQuestion?: (workerId: string, questions: string[]) => void;
  /** What `subagent` starts and `stop_task` stops. */
  subagents?: Pick<SubagentService, "start" | "stop">;
  /** What bash runs in the background, and moves there at its timeout;
   *  stop_task stops them. */
  commands?: Pick<BackgroundCommandService, "start" | "adopt" | "stop">;
  /** A conversation's queued and running tasks: list_tasks. */
  taskList?: TaskList;
  /** What runs bash's commands; the login-shell runner unless a test's. */
  shellRunner?: ShellCommandRunner;
  /** web_search and web_fetch, built once for every agent. */
  web?: WebTools;
  supportsInputForScope?: (scope: ConversationScope, input: ModelInputType) => boolean;
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  supportsToolResultImagesForThread?: (threadId: string) => boolean;
}

export interface ManagerToolPackContext {
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
  workStore: WorkItemStore;
  sessionDataDir?: string;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  tmuxRuntime: TmuxRuntime;
  sse: AgentSseEmitter;
  publishLifecycle: LifecyclePublisher;
  getSnapshot: () => TmuxSnapshot | null;
  beforeWorkerArchive?: (workerId: string) => void;
  /** For create_worker's pointer at the project's brief. */
  memory?: MemoryManager | null;
  /** The workers' plans: dismiss_work_item clears the questions one asks. */
  planStore?: PlanStore;
  /** A conversation's queued and running tasks: get_worker_status names its worker's. */
  taskList?: TaskList;
  /** A thread's duty: a thread the manager names is published with it. */
  dutySummary?: (threadId: string) => DutySummaryDto | null;
  /** The projects a thread's workers ran in: published with the thread too. */
  threadProjects?: (threadId: string) => readonly string[];
}

export interface AgentScopePackContext {
  worker: WorkerScopeDeps;
  manager: ManagerScopeDeps;
  personal: PersonalScopeDeps;
  subagent: SubagentScopeDeps;
  sideChat: SideChatScopeDeps;
}

export interface WorkerToolPackContext {
  paneMonitorManager: PaneMonitorManager;
}

export interface MandateModule {
  id: string;
  schema?: SchemaInitializer[];
  mountRoutes?: (app: Hono, ctx: ModuleRouteContext) => void;
  commonToolPacks?: (ctx: CommonToolPackContext) => ToolPack[];
  workerToolPacks?: (ctx: WorkerToolPackContext) => ToolPack[];
  managerToolPacks?: (ctx: ManagerToolPackContext) => ToolPack[];
  scopePacks?: (ctx: AgentScopePackContext) => ScopePack[];
  /** Text added after the body of the named skill when an agent loads it. */
  skillAppendices?: Readonly<Record<string, () => string>>;
}
