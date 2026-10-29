import type { ThreadModels } from "../runtime/thread-models.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";
import type { AgentScope, AgentWakeReason } from "../modules/agent/agent-store.js";
import type { AgentWakeMetadata } from "../../shared/api/agents.js";
import type { AllPendingMonitorsSnapshot, PendingMonitorsSnapshot } from "../modules/agent/pending-monitors.js";
import type { AgentStore } from "../modules/agent/agent-store.js";
import type { ManualCompactionOutcome } from "../modules/agent/compression.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { AgentUserMessageQueue } from "../modules/agent/user-message-queue.js";
import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { CanvasStore } from "../modules/canvas/canvas-store.js";
import type { Config } from "../config.js";
import type { MandateStore } from "./store.js";
import type { FeatureRow, FeaturesStore } from "../modules/features/features-store.js";
import type { AppStateErrorDto, ProjectStateDto, SkillSummaryDto } from "../../shared/api-contracts.js";
import type { ProjectRow, ProjectsStore } from "../modules/projects/projects-store.js";
import type { PaneRuntimeRegistry } from "../runtime/pane-runtime-registry.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import type { ScopeRuntime } from "../runtime/scope.js";
import type { LifecyclePublisher } from "../runtime/events.js";
import type { TmuxPoller } from "../runtime/tmux-poller.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { GitClient } from "../platform/git/git.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import type { FeaturePlanDto } from "../../shared/api/plans.js";
import type { MemoryDreamTicker } from "../modules/memory/dream-runs.js";

export interface AppDeps {
  sse: AgentSseEmitter;
  getSnapshot: () => unknown | null;
  getSnapshotError?: () => AppStateErrorDto;
  /** Computes the current projectsState DTO. Mounted into SSE so late
   *  joiners get it on connect. */
  getProjectsState: () => ProjectStateDto[];
  /** Every active feature plan, pushed on connection before the projects. */
  getFeaturePlans?: () => FeaturePlanDto[];
  managerThreads?: import("../modules/agent/manager-threads.js").ManagerThreadService;
  getManagerThreads?: () => import("../../shared/api/agents.js").ManagerThreadDto[];
  getThreadStatus?: () => import("../../shared/api/thread-status.js").ThreadStatusSnapshotDto;
  globalAgent?: import("../modules/global/global-agent-service.js").GlobalAgentService;
  getGlobalAgent?: () => import("../../shared/api/global-agent.js").GlobalAgentDto;
  /** Your agent's page: its versions and writes. */
  pageStore?: import("../modules/page/page-store.js").PageStore;
  /** The page's own data sources, and what its built-in ones read. */
  pageSources?: import("../modules/page/page-sources.js").PageSourceManager;
  pageBuiltins?: import("../modules/page/page-builtins.js").PageBuiltinDeps;
  /** What the user gives on the page. */
  pageAnswers?: import("../modules/page/page-answers.js").PageAnswers;
  /** Kilo's per-model API tags: Settings' listings feed them. */
  kiloModelApis?: { accept(connection: string, apis: ReadonlyMap<string, import("../config/kilo-model-apis.js").KiloApi>): void };
  /** The price data the pricing pass and Settings read. */
  priceData?: { catalog(): import("../modules/pricing/catalog.js").PriceCatalog; ensure?(): void; whenSettled?(timeoutMs: number): Promise<void> };
  heartbeatMs: number;
  projects: ProjectsStore;
  features: FeaturesStore;
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
  beforeFeatureArchive?: (featureId: string) => void;
  userMessageQueue: Pick<
    AgentUserMessageQueue,
    "submitUserMessage" | "submitThreadUserMessage" | "removeQueuedMessage" | "clearThread" | "skipQuestion"
  >;
  /** Per-scope runtime objects from buildAgentRuntime. API routes use these
   *  to mount feature/overview agent HTTP route trees generically. */
  scopes: Record<AgentScope, ScopeRuntime>;
  broadcast: LifecyclePublisher;
  poller: TmuxPoller;
  store: MandateStore;
  analyzer: Analyzer;
  config: Config;
  configFileExists: () => boolean;
  reloadConfig: () => Config;
  pollTmux: (opts: { forceWindowIds?: string[] }) => Promise<void>;
  computeProjectsState: (
    projects: ProjectRow[],
    features: FeatureRow[],
    tmuxState: Map<string, string[]>
  ) => ProjectStateDto[];
  tmuxListSessionsWithWindows: (client: TmuxClient) => Array<{ name: string; windows: string[] }>;
  /** The tmux runtime, by project: terminal routes resolve a pane's runtime
   *  through it and hand off attach. */
  paneRuntimes: PaneRuntimeRegistry;
  paneMetadata: PaneMetadataStore;
  /** Builds a fresh VoiceSessionOrchestrator per WS connection. */
  buildVoiceOrchestrator: (clocks: import("../modules/voice/voice-gateway.js").VoiceSessionClocks) => import("../modules/voice/voice-session-orchestrator.js").VoiceSessionOrchestrator;
  skills: {
    list: () => SkillSummaryDto[];
    refresh: () => Promise<void>;
  };
  memoryDreamJob?: () => MemoryDreamTicker | null;
}
