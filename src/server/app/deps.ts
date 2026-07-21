import type { AgentScope, AgentWakeReason } from "../modules/agent/agent-store.js";
import type { AgentStore } from "../modules/agent/agent-store.js";
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
import type { UiContextRegistry } from "../modules/ui-context/ui-context-registry.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import type { MemoryDreamJob } from "../modules/memory/dream.js";

export interface AppDeps {
  sse: AgentSseEmitter;
  getSnapshot: () => unknown | null;
  getSnapshotError?: () => AppStateErrorDto;
  /** Computes the current projectsState DTO. Mounted into SSE so late
   *  joiners get it on connect. */
  getProjectsState: () => ProjectStateDto[];
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
      triggerMessageId: string | null
    ) => string | null;
    cancelWake?: (wakeId: string) => { ok: boolean; wakeId: string; status: string; message?: string };
    isThreadBusy?: (threadId: string) => boolean;
    getRunningWakeForThread?: (threadId: string) => { id: string } | null;
  };
  beforeAgentNewChatArchive?: (threadId: string) => void;
  beforeAgentSideThreadClose?: (threadId: string) => void;
  summarizeAgentSideConversation?: (threadId: string) => Promise<string>;
  beforeFeatureArchive?: (featureId: string) => void;
  userMessageQueue?: Pick<
    AgentUserMessageQueue,
    "submitUserMessage" | "submitThreadUserMessage" | "removeQueuedMessage" | "clearThread"
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
  /** PaneRuntime registry used by terminal routes to resolve project/runtime
   *  and hand off attach. */
  paneRuntimes: PaneRuntimeRegistry;
  paneMetadata: PaneMetadataStore;
  /** Builds a fresh VoiceSessionOrchestrator per WS connection. */
  buildVoiceOrchestrator: () => import("../modules/voice/voice-session-orchestrator.js").VoiceSessionOrchestrator;
  uiContextRegistry: UiContextRegistry;
  skills: {
    list: () => SkillSummaryDto[];
    refresh: () => Promise<void>;
  };
  memoryDreamJob?: () => MemoryDreamJob | null;
}
