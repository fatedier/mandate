import type { ThreadModels } from "../runtime/thread-models.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";
import type { AgentScope, AgentWakeReason } from "../modules/agent/agent-store.js";
import type { AgentWakeMetadata } from "../../shared/api/agents.js";
import type { AllPendingMonitorsSnapshot, PendingMonitorsSnapshot } from "../modules/agent/pending-monitors.js";
import type { AgentStore } from "../modules/agent/agent-store.js";
import type { ManualCompactionOutcome } from "../modules/agent/compression.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { AgentUserMessageQueue } from "../modules/agent/user-message-queue.js";
import type { CanvasStore } from "../modules/canvas/canvas-store.js";
import type { Config } from "../config.js";
import type { MandateStore } from "./store.js";
import type { WorkersStore } from "../modules/workers/workers-store.js";
import type { AppStateErrorDto, ProjectStateDto, SkillSummaryDto } from "../../shared/api-contracts.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { TmuxRuntime } from "../runtime/runtimes/tmux-runtime.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import type { ScopeRuntime } from "../runtime/scope.js";
import type { LifecyclePublisher } from "../runtime/events.js";
import type { TmuxPoller } from "../runtime/tmux-poller.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { GitClient } from "../platform/git/git.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import type { WorkerPlanDto } from "../../shared/api/plans.js";
import type { MemoryDreamTicker } from "../modules/memory/dream-runs.js";

export interface AppDeps {
  sse: AgentSseEmitter;
  getSnapshot: () => unknown | null;
  getSnapshotError?: () => AppStateErrorDto | null;
  /** Computes the current projectsState DTO. Mounted into SSE so late
   *  joiners get it on connect. */
  getProjectsState: () => Promise<ProjectStateDto[]>;
  /** The projects DTO from tmux's newest answer, without asking it; null
   *  before tmux has answered once. */
  getProjectsStateNow?: () => ProjectStateDto[] | null;
  /** Every active worker plan as the page receives it (planForPage), pushed
   *  on connection before the projects. */
  getWorkerPlans?: () => WorkerPlanDto[];
  managerThreads?: import("../modules/agent/manager-threads.js").ManagerThreadService;
  getManagerThreads?: () => import("../../shared/api/agents.js").ManagerThreadDto[];
  getThreadStatus?: () => import("../../shared/api/thread-status.js").ThreadStatusSnapshotDto;
  personalAgent?: import("../modules/personal/personal-agent-service.js").PersonalAgentService;
  /** Where the personal agent's notices go, and the windows' presence. */
  notifications?: import("../modules/notifications/notification-service.js").NotificationService;
  getPersonalAgent?: () => import("../../shared/api/personal-agent.js").PersonalAgentDto;
  getSideChats?: () => import("../../shared/api/side-chat.js").SideChatDto[];
  getTaskBoard?: () => import("../../shared/api/task-board.js").TaskDto[];
  getStickyNotes?: () => import("../../shared/api/sticky-notes.js").StickyNotesDto;
  /** Personal agent's page: its versions and writes. */
  pageStore?: import("../modules/page/page-store.js").PageStore;
  /** The page's own data sources, and what its built-in ones read. */
  pageSources?: import("../modules/page/page-sources.js").PageSourceManager;
  pageBuiltins?: import("../modules/page/page-builtins.js").PageBuiltinDeps;
  /** The page's scheduled updates. */
  pageUpdates?: import("../modules/page/page-updates.js").PageUpdateManager;
  /** What the user gives on the page. */
  pageAnswers?: import("../modules/page/page-answers.js").PageAnswers;
  /** Side chats on Personal agent's page. */
  sideChats?: Pick<import("../modules/side-chat/side-chat-service.js").SideChatService, "open" | "list" | "rename" | "markSeen" | "summary" | "send" | "discard">;
  /** The owner's task board: its one writer. */
  taskBoard?: import("../modules/task-board/task-board-service.js").TaskBoardService;
  /** The personal agent's sticky notes for the user: their one writer. */
  stickyNotes?: import("../modules/sticky-notes/sticky-notes-service.js").StickyNotesService;
  /** The personal agent's calendar: the page's pause, resume, skip and delete. */
  calendar?: import("../modules/calendar/calendar-service.js").CalendarService;
  /** The projects a thread's workers ran in, by name: the archived list says them. */
  threadProjects?: (threadId: string) => readonly string[];
  /** The labels of manager threads: the owner's routes and the personal agent's tool. */
  threadLabels?: import("../modules/agent/thread-labels.js").ThreadLabels;
  /** A schedule's last checks, read by its chip. */
  schedules?: Pick<import("../modules/schedules/schedule-manager.js").ScheduleManager,
    "runs" | "threadDeleting" | "ownerPause" | "ownerResume" | "ownerRunNow" | "addToSidebar" | "removeFromSidebar">;
  /** What became of duty threads' replies, by message id. */
  dutyReportsFor?: (messageIds: string[]) => ReadonlyMap<string, import("../../shared/api/schedules.js").DutyReportOutcome>;
  /** Kilo's per-model API tags: Settings' listings feed them. */
  kiloModelApis?: { accept(connection: string, apis: ReadonlyMap<string, import("../config/kilo-model-apis.js").KiloApi>): void };
  /** The price data the pricing pass and Settings read. */
  priceData?: { catalog(): import("../modules/pricing/catalog.js").PriceCatalog; ensure?(): void; whenSettled?(timeoutMs: number): Promise<void> };
  heartbeatMs: number;
  projects: ProjectsStore;
  workers: WorkersStore;
  canvasStore: CanvasStore;
  sessionDataDir?: string;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  agentStore: AgentStore;
  workStore: WorkItemStore;
  wakeScheduler: {
    wake: (
      threadId: string,
      reason: AgentWakeReason,
      triggerMessageId: string | null,
      metadata?: AgentWakeMetadata | null
    ) => string | null;
    cancelWake?: (wakeId: string) => { ok: boolean; wakeId: string; status: string; message?: string };
    isThreadBusy?: (threadId: string) => boolean;
    getRunningWakeForThread?: (threadId: string) => { id: string } | null;
    modelInFlight?: (threadId: string) => import("../../shared/api/agents.js").ModelRefDto | null;
  };
  /** Archives a thread together with its workers. */
  threadArchive?: import("../modules/agent/thread-archive.js").ThreadArchive;
  /** A thread's background tasks: listed, and stopped by the user. */
  backgroundTasks?: import("../modules/agent/agent-http-service.js").AgentsApiDeps["backgroundTasks"];
  /** A compaction started by hand: see AgentRuntime.compaction. */
  compaction?: {
    start: (threadId: string) => ManualCompactionOutcome;
    inFlight: (threadId: string) => boolean;
  };
  /** Whether work the runtime holds will still write to a thread: see
   *  AgentRuntime.isThreadWorking. */
  isThreadWorking?: (threadId: string) => boolean;
  /** What a thread's agent is still waiting on: its pending monitors. */
  pendingMonitors?: (threadId: string) => PendingMonitorsSnapshot;
  /** A thread's model as its composer shows and sets it. */
  threadModels?: Pick<ThreadModels, "state" | "set">;
  /** Whether the model a thread runs on first takes this input. */
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  /** Every thread that waits on something, for the sidebar. */
  allPendingMonitors?: () => AllPendingMonitorsSnapshot;
  /** The models whose cache seal is paused, for Activity. */
  cacheSealPauses?: () => import("../modules/agent/cache-seal/seal-ledger.js").SealPause[];
  beforeWorkerArchive?: (workerId: string) => void;
  userMessageQueue: Pick<
    AgentUserMessageQueue,
    "submitUserMessage" | "submitThreadUserMessage" | "removeQueuedMessage" | "clearThread" | "skipQuestion"
  >;
  /** Per-scope runtime objects from buildAgentRuntime. API routes use these
   *  to mount worker/manager agent HTTP route trees generically. */
  scopes: Record<AgentScope, ScopeRuntime>;
  broadcast: LifecyclePublisher;
  poller: TmuxPoller;
  store: MandateStore;
  config: Config;
  configFileExists: () => boolean;
  reloadConfig: () => Config;
  pollTmux: (opts: { forceWindowIds?: string[] }) => Promise<void>;
  /** The tmux runtime the terminal route attaches viewers through. */
  tmuxRuntime: TmuxRuntime;
  paneMetadata: PaneMetadataStore;
  /** Builds a fresh VoiceSessionOrchestrator per WS connection. */
  buildVoiceOrchestrator: (clocks: import("../modules/voice/voice-gateway.js").VoiceSessionClocks) => import("../modules/voice/voice-session-orchestrator.js").VoiceSessionOrchestrator;
  skills: {
    list: () => SkillSummaryDto[];
    refresh: () => Promise<void>;
  };
  /** Learned skills, read only: the Memory page's Skills view. */
  learnedSkills?: import("../modules/skills/skill-routes.js").LearnedSkillRouteDeps;
  memoryDreamJob?: () => MemoryDreamTicker | null;
}
