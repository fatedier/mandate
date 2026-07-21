import type { MandateStore } from "../app/store.js";
import type { AgentScope, AgentStore } from "../modules/agent/agent-store.js";
import type { AgentUserMessageQueue } from "../modules/agent/user-message-queue.js";
import type { WakeScheduler } from "../modules/agent/wake-loop.js";
import type { WindowWatchManager } from "../modules/agent/window-watch-manager.js";
import type { AgentAlarmManager } from "../modules/agent/agent-alarm-manager.js";
import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { CanvasStore } from "../modules/canvas/canvas-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { MemoryManager } from "../modules/memory/manager.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import type { SweepController } from "../modules/agent/tools/sweep-tools.js";
import {
  buildAgentScopePacks,
  buildCommonToolPacks,
  buildWorkerToolPacks,
  buildManagerToolPacks
} from "../modules/registry.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { SkillRegistry } from "../modules/skills/skill-registry.js";
import type { UiContextRegistry } from "../modules/ui-context/ui-context-registry.js";
import type { Config, ResolvedProviderConfig } from "../config.js";
import { modelSupportsInput } from "../config.js";
import type { TmuxSnapshot } from "../platform/tmux/tmux-types.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { GitClient } from "../platform/git/git.js";
import type { LifecyclePublisher } from "./events.js";
import type { PaneRuntimeRegistry } from "./pane-runtime-registry.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import type { ScopeRuntime } from "./scope.js";
import { buildScopesFromPacks } from "./scope-packs.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";

export interface AgentRuntimeScopeDeps {
  config: Config;
  store: MandateStore;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  workStore: WorkItemStore;
  analyzer: Analyzer;
  sse: AgentSseEmitter;
  publishLifecycle: LifecyclePublisher;
  skillRegistry: SkillRegistry;
  getSnapshot: () => TmuxSnapshot | null;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  paneRuntimes: PaneRuntimeRegistry;
  paneMetadata?: PaneMetadataStore;
  sessionDataDir?: string;
  uiContextRegistry?: UiContextRegistry;
  windowWatchManager: WindowWatchManager;
  alarmManager: AgentAlarmManager;
  memoryManager: MemoryManager;
  canvasStore: CanvasStore;
  getWakeScheduler: () => WakeScheduler;
  /** Lazy like `getWakeScheduler`: the heartbeat that backs this is constructed
   *  after the scopes are. */
  sweepController?: SweepController;
  userMessageQueue?: Pick<AgentUserMessageQueue, "submitThreadUserMessage">;
  markPendingTaskWake?: (threadId: string) => void;
  markPendingMailboxWake?: (threadId: string) => void;
  beforeFeatureArchive?: (featureId: string) => void;
  supportsInputForScope?: (scope: AgentScope, input: ModelInputType) => boolean;
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  supportsToolResultImagesForThread?: (threadId: string) => boolean;
}

export function createAgentRuntimeScopes(
  deps: AgentRuntimeScopeDeps
): Record<AgentScope, ScopeRuntime> {
  const supportsInputForScope = deps.supportsInputForScope ??
    ((scope: AgentScope, input: ModelInputType): boolean => {
      if (input === "text") return true;
      const modelRef = scope === "manager"
        ? deps.config.agent.manager.modelRef
        : deps.config.agent.worker.modelRef;
      return modelSupportsInput(deps.config, modelRef, input);
    });
  const supportsInputForThread = deps.supportsInputForThread ??
    ((threadId: string, input: ModelInputType): boolean => {
      const thread = deps.agentStore.getThreadById(threadId);
      return supportsInputForScope(thread?.scope ?? "worker", input);
    });
  const supportsToolResultImagesForThread = deps.supportsToolResultImagesForThread ??
    ((threadId: string): boolean => {
      const thread = deps.agentStore.getThreadById(threadId);
      const provider = thread?.scope === "manager" ? deps.config.agent.manager : deps.config.agent.worker;
      return supportsInputForThread(threadId, "image") && providerSupportsToolResultImages(provider);
    });

  const workerToolPacks = [
    ...buildCommonToolPacks({
      scope: "worker",
      store: deps.store,
      agentStore: deps.agentStore,
      projectsStore: deps.projectsStore,
      featuresStore: deps.featuresStore,
      workStore: deps.workStore,
      skillRegistry: deps.skillRegistry,
      uiContextRegistry: deps.uiContextRegistry,
      watchManager: deps.windowWatchManager,
      alarmManager: deps.alarmManager,
      sweepController: deps.sweepController,
      memory: deps.memoryManager,
      canvasStore: deps.canvasStore,
      sse: deps.sse,
      getWakeScheduler: deps.getWakeScheduler,
      userMessageQueue: deps.userMessageQueue,
      markPendingTaskWake: deps.markPendingTaskWake,
      markPendingMailboxWake: deps.markPendingMailboxWake,
      supportsInputForScope,
      supportsInputForThread,
      supportsToolResultImagesForThread
    }),
    ...buildWorkerToolPacks({ watchManager: deps.windowWatchManager })
  ];
  const managerToolPacks = [
    ...buildCommonToolPacks({
      scope: "manager",
      store: deps.store,
      agentStore: deps.agentStore,
      projectsStore: deps.projectsStore,
      featuresStore: deps.featuresStore,
      workStore: deps.workStore,
      skillRegistry: deps.skillRegistry,
      uiContextRegistry: deps.uiContextRegistry,
      watchManager: deps.windowWatchManager,
      alarmManager: deps.alarmManager,
      sweepController: deps.sweepController,
      memory: deps.memoryManager,
      canvasStore: deps.canvasStore,
      sse: deps.sse,
      getWakeScheduler: deps.getWakeScheduler,
      userMessageQueue: deps.userMessageQueue,
      markPendingTaskWake: deps.markPendingTaskWake,
      markPendingMailboxWake: deps.markPendingMailboxWake,
      supportsInputForScope,
      supportsInputForThread,
      supportsToolResultImagesForThread
    }),
    ...buildManagerToolPacks({
      config: deps.config,
      agentStore: deps.agentStore,
      projectsStore: deps.projectsStore,
      featuresStore: deps.featuresStore,
      workStore: deps.workStore,
      sessionDataDir: deps.sessionDataDir,
      tmuxClient: deps.tmuxClient,
      gitClient: deps.gitClient,
      paneRuntimes: deps.paneRuntimes,
      sse: deps.sse,
      publishLifecycle: deps.publishLifecycle,
      getSnapshot: deps.getSnapshot,
      getWakeScheduler: deps.getWakeScheduler,
      beforeFeatureArchive: deps.beforeFeatureArchive
    })
  ];

  return buildScopesFromPacks(
    buildAgentScopePacks({
      worker: {
        config: deps.config,
        agentStore: deps.agentStore,
        projectsStore: deps.projectsStore,
        featuresStore: deps.featuresStore,
        analyzer: deps.analyzer,
        tmuxClient: deps.tmuxClient,
        paneRuntimes: deps.paneRuntimes,
        paneMetadata: deps.paneMetadata,
        skillRegistry: deps.skillRegistry,
        memory: deps.memoryManager,
        toolPacks: workerToolPacks
      },
      manager: {
        config: deps.config,
        agentStore: deps.agentStore,
        projectsStore: deps.projectsStore,
        featuresStore: deps.featuresStore,
        workStore: deps.workStore,
        skillRegistry: deps.skillRegistry,
        memory: deps.memoryManager,
        toolPacks: managerToolPacks
      }
    }),
    ["worker", "manager"]
  );
}

export function providerSupportsToolResultImages(
  provider: Pick<ResolvedProviderConfig, "provider">,
  modelProvider?: string
): boolean {
  const aiSdkProvider = modelProvider?.toLowerCase().trim() ?? "";
  if (aiSdkProvider.endsWith(".chat")) return false;
  if (aiSdkProvider.endsWith(".responses")) return true;
  switch (provider.provider) {
    case "codex":
    case "openai":
    case "anthropic":
    case "google":
      return true;
    default:
      return false;
  }
}

export function providerInstanceSupportsToolResultImages(input: {
  meta: Pick<ResolvedProviderConfig, "provider">;
  model: unknown;
}): boolean {
  return providerSupportsToolResultImages(input.meta, languageModelProvider(input.model));
}

function languageModelProvider(model: unknown): string | undefined {
  const provider = (model as { provider?: unknown })?.provider;
  return typeof provider === "string" ? provider : undefined;
}
