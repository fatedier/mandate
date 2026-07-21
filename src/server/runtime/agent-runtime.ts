import type { MandateStore } from "../app/store.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { AgentStore, AgentScope } from "../modules/agent/agent-store.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import { broadcastWorkItemCreated } from "../modules/agent/work-item-created-broadcast.js";
import { isFeatureTaskDispatchContent } from "../modules/agent/feature-task-dispatch-message.js";
import { WakeLock } from "../modules/agent/wake-lock.js";
import { WakeScheduler } from "../modules/agent/wake-loop.js";
import type { WakeFinishedEvent } from "../modules/agent/wake-loop.js";
import { AgentUserMessageQueue } from "../modules/agent/user-message-queue.js";
import type { SkillRegistry } from "../modules/skills/skill-registry.js";
import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { GitClient } from "../platform/git/git.js";
import type { PaneRuntimeRegistry } from "./pane-runtime-registry.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import { paneReadCursors } from "../modules/panes/pane-read-cursor.js";
import type { LifecyclePublisher } from "./events.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { CanvasStore } from "../modules/canvas/canvas-store.js";
import { modelSupportsInput, type Config } from "../config.js";
import type { ScopeRuntime } from "./scope.js";
import {
  WindowWatchManager,
  type WindowWatchTargetState
} from "../modules/agent/window-watch-manager.js";
import { AgentAlarmManager } from "../modules/agent/agent-alarm-manager.js";
import type { TmuxSnapshot } from "../platform/tmux/tmux-types.js";
import type { UiContextRegistry } from "../modules/ui-context/ui-context-registry.js";
import { createAgentCompressionController } from "./agent-compression-controller.js";
import { createAgentRuntimeLlmRecorders } from "./agent-llm-recorders.js";
import { createAgentRuntimeScopes, providerInstanceSupportsToolResultImages } from "./agent-scopes.js";
import type { ManagerScopeRuntime } from "./scopes/manager-scope.js";
import { createAgentRuntimeProviders } from "./agent-providers.js";
import type { AgentRuntimeProviderSet } from "./agent-providers.js";
import { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import { normalizeLogRequests } from "../modules/activity/llm-call-logging.js";
import { compressionApiMode } from "./agent-compression-llm.js";
import {
  createAgentRuntimeMemoryManager,
  reloadAgentRuntimeMemoryManager
} from "./agent-memory.js";
import { buildFeatureArchiveMemorySource, buildNewChatMemorySource } from "./agent-memory-hooks.js";
import {
  extractFeatureArchiveMemories,
  extractNewChatMemories
} from "../modules/memory/extraction.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import { ManagerWorkItemHeartbeat } from "./manager-work-item-heartbeat.js";
import {
  enqueueManagerLimitReachedEvent,
  wakeManagerForLimitReached
} from "./agent-limit-reached-events.js";
import { relayFeatureMessageReply } from "./feature-message-relay.js";

interface AgentRuntimeDeps {
  config: Config;
  ready?: Promise<void>;
  store: MandateStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  agentStore: AgentStore;
  workStore: WorkItemStore;
  canvasStore: CanvasStore;
  paneMetadata?: PaneMetadataStore;
  sessionDataDir?: string;
  analyzer: Analyzer;
  sse: AgentSseEmitter;
  publishLifecycle: LifecyclePublisher;
  skillRegistry: SkillRegistry;
  /** Pulled lazily so the latest dashboard is visible to manager tools
   *  (e.g. get_feature_status) without threading the poller through. */
  getSnapshot: () => TmuxSnapshot | null;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  /** Per-project pane runtime registry. */
  paneRuntimes: PaneRuntimeRegistry;
  uiContextRegistry?: UiContextRegistry;
}

export interface AgentRuntime {
  wakeScheduler: WakeScheduler;
  userMessageQueue: AgentUserMessageQueue;
  /** Per-scope runtime objects, keyed by AgentScope. agents-api uses these
   *  to mount HTTP routes generically and to reach scope-specific behavior
   *  (verifyScopeId for the route gate). */
  scopes: Record<AgentScope, ScopeRuntime>;
  /** Subscribe to wake-finished events. Used by voice agent to deliver
   *  dispatch_to_manager results back to the realtime model. */
  onWakeFinished(cb: (event: WakeFinishedEvent) => void): () => void;
  /** Called by the HTTP new-chat route before the previous chat thread is archived. */
  beforeNewChatArchive(threadId: string): void;
  /** Cancels conversation-local resources before an ephemeral side thread closes. */
  beforeSideThreadClose(threadId: string): void;
  summarizeSideConversation(threadId: string): Promise<string>;
  /** Called by feature archive paths before the feature thread is archived. */
  beforeFeatureArchive(featureId: string): void;
  /** Refresh model/provider-dependent runtime handles after config.json changes. */
  reloadConfig(config: Config): void;
  dispose(): void;
}

/** Wire up the entire agent stack: per-scope runtimes (registries +
 *  dispatchers + prompts), the WakeScheduler, and the two cross-cutting
 *  bridges (analyzer→agent, dispatch→handoff).
 *
 *  Adding a third scope is one more buildXxxScope() call here plus a key
 *  in the AgentScope union — no other code changes. */
export function buildAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  let { config } = deps;
  const {
    store,
    projectsStore,
    featuresStore,
    agentStore,
    workStore,
    analyzer,
    sse,
    skillRegistry,
    getSnapshot,
    tmuxClient,
    paneRuntimes
  } = deps;

  let providers = createAgentRuntimeProviders(config);
  let recorders = createAgentRuntimeLlmRecorders({ config, store });
  const wakeLock = new WakeLock();
  const wakeFinishedSubscribers = new Set<(e: WakeFinishedEvent) => void>();
  let managerWorkItemHeartbeat: ManagerWorkItemHeartbeat | null = null;
  agentStore.recoverInterruptedWakes("Mandate server restarted before this wake finished.", (thread) => {
    if (thread.scope === "manager") return true;
    const feature = thread.scopeId ? featuresStore.getById(thread.scopeId) : null;
    const project = feature ? projectsStore.getById(feature.projectId) : null;
    return Boolean(feature && !feature.archivedAt && project && !project.archivedAt);
  });
  const staleSideThreadIds = agentStore.closeOpenEphemeralSideThreads();

  // Forward declaration: scopes' onWake closures need wakeScheduler.wake,
  // but the scheduler needs the scopes (for prompt + dispatcher). Capture
  // the variable; assign after both sides are constructed.
  let wakeScheduler!: WakeScheduler;
  const scheduleWake = (
    threadId: string,
    reason: Parameters<typeof wakeScheduler.wake>[1],
    triggerMessageId: string | null
  ) => wakeScheduler.wake(threadId, reason, triggerMessageId);
  const pendingFeatureTaskWakeThreads = new Set<string>();
  const markPendingTaskWake = (threadId: string) => {
    pendingFeatureTaskWakeThreads.add(threadId);
  };
  const userMessageQueue = new AgentUserMessageQueue({
    agentStore,
    sse,
    workStore,
    wakeScheduler: {
      wake: scheduleWake,
      isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
      getRunningWakeForThread: (threadId) => wakeScheduler.getRunningWakeForThread(threadId)
    },
    onPendingTaskMessageFlushed: (threadId) => markPendingTaskWake(threadId)
  });

  const pendingMailboxWakeThreads = new Set<string>();
  const markPendingMailboxWake = (threadId: string) => {
    pendingMailboxWakeThreads.add(threadId);
  };
  const drainMailboxIntoThread = (
    threadId: string,
    wakeId: string,
    opts: { markFeatureTaskWake?: boolean } = {}
  ) => {
    const mailboxMessages = agentStore.drainMailboxToMessages(threadId, wakeId);
    for (const message of mailboxMessages) {
      sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message });
      if (opts.markFeatureTaskWake && isFeatureTaskDispatchContent(message.content)) {
        markPendingTaskWake(threadId);
      }
    }
  };
  const featureEventWakeMetadata = (threadId: string) => {
    const featureEvents = agentStore
      .listPendingFeatureEvents(threadId, 50)
      .map((event) => event.content);
    return featureEvents.length > 0 ? { featureEvents } : null;
  };
  const flushMailboxWakeIfIdle = (threadId: string): string | null => {
    if (wakeScheduler.isThreadBusy(threadId) || wakeScheduler.getRunningWakeForThread(threadId))
      return null;
    const hasQueuedMessages = agentStore.hasQueuedMailboxMessages(threadId);
    const hasQueuedFeatureEvents = agentStore.hasQueuedFeatureEvents(threadId);
    if (!hasQueuedMessages && !hasQueuedFeatureEvents) {
      pendingMailboxWakeThreads.delete(threadId);
      return null;
    }
    pendingMailboxWakeThreads.delete(threadId);
    return wakeScheduler.wake(
      threadId,
      hasQueuedMessages ? "user" : "feature-event",
      null,
      hasQueuedFeatureEvents ? featureEventWakeMetadata(threadId) : null
    );
  };
  const flushPendingTaskWake = (threadId: string): string | null => {
    if (!pendingFeatureTaskWakeThreads.has(threadId)) return null;
    if (userMessageQueue.isFlushBlocked(threadId) || userMessageQueue.pendingCount(threadId) > 0)
      return null;
    pendingFeatureTaskWakeThreads.delete(threadId);
    if (!agentStore.hasOpenTasksForThread(threadId)) return null;
    return wakeScheduler.wake(threadId, "user", null);
  };
  const windowWatchManager = new WindowWatchManager({
    db: store.db,
    agentStore,
    sse,
    onWake: (threadId, reason, triggerMessageId) =>
      scheduleWake(threadId, reason, triggerMessageId),
    isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
    getPaneState: (windowKey, paneId) => currentPaneWatchState(getSnapshot(), windowKey, paneId),
    capturePaneTail: async (windowKey, paneId, lines) => {
      const parsed = parseWindowWatchKey(windowKey);
      if (!parsed) return null;
      const project = projectsStore.getActiveByTmuxSessionName(parsed.sessionName);
      if (!project) return null;
      return paneRuntimes.forProject(project.id).readScrollback(paneId, { tailLines: lines });
    }
  });
  const alarmManager = new AgentAlarmManager({
    db: store.db,
    agentStore,
    sse,
    onWake: (threadId, reason, triggerMessageId) => scheduleWake(threadId, reason, triggerMessageId)
  });
  for (const threadId of staleSideThreadIds) {
    windowWatchManager.cancelThread(threadId);
    alarmManager.cancelThread(threadId);
  }
  const memoryManager = createAgentRuntimeMemoryManager({ config, store });
  const wakeCandidatesFor = (
    providerSet: AgentRuntimeProviderSet,
    primaryRecorder: AgentLlmCallRecorder
  ) =>
    providerSet.candidates.map((candidate, index) => ({
      model: candidate.model,
      meta: candidate.meta,
      supportsImageInput: modelSupportsInput(
        config,
        `${candidate.meta.providerName}/${candidate.meta.model}`,
        "image"
      ),
      supportsToolResultImages: providerInstanceSupportsToolResultImages(candidate),
      llmCallRecorder:
        index === 0
          ? primaryRecorder
          : new AgentLlmCallRecorder({
              store,
              logRequests: normalizeLogRequests(config.agent.logRequests),
              provider: candidate.meta.provider,
              providerName: candidate.meta.providerName,
              model: candidate.meta.model,
              baseURL: candidate.meta.baseURL || "",
              apiMode: "streamText"
            })
    }));
  const maintenanceCandidatesFor = (
    providerSet: AgentRuntimeProviderSet,
    primaryRecorder: AgentLlmCallRecorder
  ) =>
    providerSet.candidates.map((candidate, index) => ({
      model: candidate.model,
      provider: candidate.meta.provider,
      reasoningEffort: candidate.meta.reasoningEffort,
      supportsReasoning: candidate.meta.supportsReasoning,
      recorder:
        index === 0
          ? primaryRecorder
          : new AgentLlmCallRecorder({
              store,
              logRequests: normalizeLogRequests(config.agent.logRequests),
              provider: candidate.meta.provider,
              providerName: candidate.meta.providerName,
              model: candidate.meta.model,
              baseURL: candidate.meta.baseURL || "",
              apiMode: compressionApiMode(candidate.meta.provider)
            })
    }));

  const compressionForThread = (threadId: string) => {
    const thread = agentStore.getThreadById(threadId);
    if (thread?.scope === "manager") {
      return {
        model: providers.managerProvider.model,
        provider: providers.managerProvider.meta.provider,
        reasoningEffort: providers.managerProvider.meta.reasoningEffort,
        supportsReasoning: providers.managerProvider.meta.supportsReasoning,
        recorder: recorders.compressionManagerRecorder,
        candidates: maintenanceCandidatesFor(
          providers.managerProvider,
          recorders.compressionManagerRecorder
        )
      };
    }
    return {
      model: providers.workerProvider.model,
      provider: providers.workerProvider.meta.provider,
      reasoningEffort: providers.workerProvider.meta.reasoningEffort,
      supportsReasoning: providers.workerProvider.meta.supportsReasoning,
      recorder: recorders.compressionWorkerRecorder,
      candidates: maintenanceCandidatesFor(
        providers.workerProvider,
        recorders.compressionWorkerRecorder
      )
    };
  };
  const memoryExtractionForThread = (threadId: string) => {
    const thread = agentStore.getThreadById(threadId);
    if (thread?.scope === "manager") {
      return {
        model: providers.managerProvider.model,
        provider: providers.managerProvider.meta.provider,
        reasoningEffort: providers.managerProvider.meta.reasoningEffort,
        supportsReasoning: providers.managerProvider.meta.supportsReasoning,
        recorder: recorders.memoryExtractionManagerRecorder
      };
    }
    return {
      model: providers.workerProvider.model,
      provider: providers.workerProvider.meta.provider,
      reasoningEffort: providers.workerProvider.meta.reasoningEffort,
      supportsReasoning: providers.workerProvider.meta.supportsReasoning,
      recorder: recorders.memoryExtractionWorkerRecorder
    };
  };
  const beforeFeatureArchive = (featureId: string) => {
    const source = buildFeatureArchiveMemorySource(featureId, {
      agentStore,
      projectsStore,
      featuresStore
    });
    const threadId = source?.threadId;
    if (!threadId) return;
    void (async () => {
      const extraction = memoryExtractionForThread(threadId);
      await extractFeatureArchiveMemories({
        memory: memoryManager,
        source,
        model: extraction.model,
        provider: extraction.provider,
        reasoningEffort: extraction.reasoningEffort,
        supportsReasoning: extraction.supportsReasoning,
        recorder: extraction.recorder
      });
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mandate] memory feature-archive extraction failed: ${msg}`);
    });
  };
  const supportsInputForScope = (
    scope: AgentScope,
    input: Parameters<typeof modelSupportsInput>[2]
  ) => {
    if (input === "text") return true;
    const modelRef = scope === "manager"
      ? config.agent.manager.modelRef
      : config.agent.worker.modelRef;
    return modelSupportsInput(config, modelRef, input);
  };
  const supportsInputForThread = (
    threadId: string,
    input: Parameters<typeof modelSupportsInput>[2]
  ) => {
    const thread = agentStore.getThreadById(threadId);
    return supportsInputForScope(thread?.scope ?? "worker", input);
  };
  const supportsToolResultImagesForThread = (threadId: string) => {
    const thread = agentStore.getThreadById(threadId);
    const providerSet = thread?.scope === "manager" ? providers.managerProvider : providers.workerProvider;
    const primary = providerSet.candidates[0] ?? providerSet;
    return supportsInputForThread(threadId, "image") && providerInstanceSupportsToolResultImages(primary);
  };
  const scopes = createAgentRuntimeScopes({
    config,
    store,
    agentStore,
    projectsStore,
    featuresStore,
    workStore,
    analyzer,
    sse,
    publishLifecycle: deps.publishLifecycle,
    skillRegistry,
    getSnapshot,
    tmuxClient,
    gitClient: deps.gitClient,
    paneRuntimes,
    paneMetadata: deps.paneMetadata,
    sessionDataDir: deps.sessionDataDir,
    uiContextRegistry: deps.uiContextRegistry,
    windowWatchManager,
    alarmManager,
    memoryManager,
    canvasStore: deps.canvasStore,
    getWakeScheduler: () => wakeScheduler,
    // Reads the binding at call time: the heartbeat is constructed below, after
    // the scopes it hands this to.
    sweepController: {
      endSweep: () => managerWorkItemHeartbeat?.endSweep(),
      isEnded: () => managerWorkItemHeartbeat?.isEnded() ?? false
    },
    userMessageQueue,
    markPendingTaskWake,
    markPendingMailboxWake,
    beforeFeatureArchive,
    supportsInputForScope,
    supportsInputForThread,
    supportsToolResultImagesForThread
  });

  const scopeForThread = (threadId: string): ScopeRuntime | null => {
    const t = agentStore.getThreadById(threadId);
    return t ? scopes[t.scope] : null;
  };

  const buildSystemPromptForThread = async (threadId: string) => {
    const base = (await scopeForThread(threadId)?.buildSystemPrompt(threadId)) ?? "";
    const thread = agentStore.getThreadById(threadId);
    return thread?.kind === "side" ? `${base}\n\n${SIDE_SYSTEM_INSTRUCTIONS}`.trim() : base;
  };
  const buildRuntimeContextForThread = async (threadId: string) => {
    return (await scopeForThread(threadId)?.buildRuntimeContext?.(threadId)) ?? null;
  };
  const buildInitialContextForThread = async (threadId: string) => {
    return (await scopeForThread(threadId)?.buildInitialContext?.(threadId)) ?? null;
  };
  const flushPendingSideTransfer = (threadId: string): string | null => {
    if (wakeScheduler.isThreadBusy(threadId)) return null;
    const transfer = agentStore.listPendingSideTransfers(threadId)[0];
    if (!transfer) return null;
    const delivered = agentStore.deliverSideTransfer(transfer.id);
    if (!delivered) {
      const updated = agentStore.getSideTransferById(transfer.id);
      if (updated) sse.emit(SSE_EVENTS.agentSideTransferUpdated, updated);
      return null;
    }
    sse.emit(SSE_EVENTS.agentSideTransferUpdated, delivered.transfer);
    sse.emit(SSE_EVENTS.agentMessageAppended, {
      threadId,
      message: delivered.message
    });
    return wakeScheduler.wake(threadId, "side-summary", delivered.message.id);
  };
  const compressionController = createAgentCompressionController({
    config,
    getConfig: () => config,
    store,
    projectsStore,
    featuresStore,
    agentStore,
    sse,
    compressionForThread,
    buildSystemPrompt: buildSystemPromptForThread,
    supportsInputForThread,
    memoryManager,
    memoryExtractionForThread,
    // Same singleton the pane tool pack hands read_pane; compression drops a
    // thread's cursors because it may have summarized away the messages that
    // held those pane lines.
    cursors: paneReadCursors
  });

  wakeScheduler = new WakeScheduler({
    agentStore,
    ready: deps.ready,
    lock: wakeLock,
    maxStepsPerWake: () => config.agent.maxStepsPerWake,
    buildSystemPrompt: buildSystemPromptForThread,
    buildInitialContext: buildInitialContextForThread,
    buildRuntimeContext: buildRuntimeContextForThread,
    toolDispatcherForThread: (threadId) =>
      (scopeForThread(threadId) ?? scopes.worker).wrappedDispatcher,
    llmModel: providers.workerProvider.model,
    contextBudgetTokens: () => compressionController.contextBudgetTokens,
    llmForThread: (threadId) => {
      const thread = agentStore.getThreadById(threadId);
      if (thread?.scope === "manager") {
        return {
          model: providers.managerProvider.model,
          llmCallRecorder: recorders.managerWakeRecorder,
          candidates: wakeCandidatesFor(providers.managerProvider, recorders.managerWakeRecorder)
        };
      }
      return {
        model: providers.workerProvider.model,
        llmCallRecorder: recorders.workerWakeRecorder,
        candidates: wakeCandidatesFor(providers.workerProvider, recorders.workerWakeRecorder)
      };
    },
    supportsInputForThread,
    supportsToolResultImagesForThread,
    sse,
    uiContext: deps.uiContextRegistry
      ? {
          getLocationForThread: (threadId) =>
            deps.uiContextRegistry?.getLocationForThread(threadId) ?? null
        }
      : undefined,
    buildToolScope: (threadId) => {
      const scope = scopeForThread(threadId);
      if (!scope) throw new Error(`thread not found: ${threadId}`);
      return scope.buildToolScope(threadId);
    },
    preWakeHook: async (threadId, info) => {
      if (agentStore.getThreadById(threadId)?.scope === "manager") {
        managerWorkItemHeartbeat?.noteManagerWakeStarted(
          info.reason === "work-item-heartbeat"
          || agentStore.getWakeById(info.wakeId)?.metadata?.recovery?.originalReason === "work-item-heartbeat"
        );
      }
      drainMailboxIntoThread(threadId, info.wakeId);
    },
    preStepHook: (threadId, info) => {
      userMessageQueue.flushQueuedIntoThread(threadId);
      drainMailboxIntoThread(threadId, info.wakeId, { markFeatureTaskWake: true });
    },
    beforeModelCallHook: (threadId, info) =>
      compressionController.beforeModelCallHook(threadId, info),
    postWakeHook: async (threadId, info) => {
      relayFeatureMessageReply({
        agentStore,
        featuresStore,
        wakeScheduler,
        markPendingMailboxWake
      }, {
        threadId,
        wakeId: info.wakeId,
        status: info.status
      });
      const limitReachedEvent = info.status === "limit_reached"
        ? enqueueManagerLimitReachedEvent({
          agentStore,
          projectsStore,
          featuresStore,
          workStore
        }, {
          threadId,
          wakeId: info.wakeId,
          stepCount: info.stepCount
        })
        : null;
      if (limitReachedEvent) {
        wakeManagerForLimitReached({
          wakeScheduler: {
            wake: (targetThreadId, reason, triggerMessageId, metadata) =>
              wakeScheduler.wake(targetThreadId, reason, triggerMessageId, metadata)
          },
          markPendingMailboxWake
        }, limitReachedEvent);
      }
      // For manager threads: commit the work-item wake section marks only
      // after the LLM turn completed successfully (not on error/canceled).
      // This must run before the wake lock is released so the release-time
      // mailbox flush cannot misread a consumed feature_event as a new wake.
      if (info.status === "finished" || info.status === "limit_reached") {
        const thread = agentStore.getThreadById(threadId);
        if (thread?.scope === "manager") {
          const managerScope = scopes["manager"] as ManagerScopeRuntime | undefined;
          const marks = managerScope?.drainPendingMarks?.();
          if (marks) {
            try {
              agentStore.markFeatureEventsProcessed(marks.processedEventIds);
            } catch {
              // Non-fatal: next wake will re-surface the same events.
            }
          }
        }
      }
    },
    afterWakeReleasedHook: async (threadId) => {
      const userWakeId = userMessageQueue.flushIfIdle(threadId);
      if (userWakeId) return;
      const sideTransferWakeId = flushPendingSideTransfer(threadId);
      if (sideTransferWakeId) return;
      const mailboxWakeId = flushMailboxWakeIfIdle(threadId);
      if (mailboxWakeId) return;
      const taskWakeId = flushPendingTaskWake(threadId);
      if (taskWakeId) return;
      const watchWakeId = await windowWatchManager.flushPendingWake(threadId);
      if (watchWakeId) return;
      if (agentStore.getThreadById(threadId)?.scope === "manager") {
        managerWorkItemHeartbeat?.flushDueAfterOverviewRelease();
      }
    },
    wakeFinishedHook: (event) => {
      for (const cb of wakeFinishedSubscribers) {
        try {
          cb(event);
        } catch {
          /* ignore */
        }
      }
    },
    llmCallRecorder: recorders.workerWakeRecorder
  });

  managerWorkItemHeartbeat = new ManagerWorkItemHeartbeat({
    agentStore,
    wakeScheduler: {
      wake: (threadId, reason, triggerMessageId) =>
        wakeScheduler.wake(threadId, reason, triggerMessageId),
      isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
      getRunningWakeForThread: (threadId) => wakeScheduler.getRunningWakeForThread(threadId)
    }
  });
  const unsubscribeWorkItemHeartbeat = [
    workStore.onChange(() => managerWorkItemHeartbeat?.notifyWorkItemChanged()),
    featuresStore.onWorkItemChange(() => managerWorkItemHeartbeat?.notifyWorkItemChanged()),
    broadcastWorkItemCreated({ workStore, featuresStore, sse })
  ];
  for (const threadId of agentStore.listThreadIdsWithQueuedMailboxMessages()) {
    wakeScheduler.wake(threadId, "user", null);
  }
  for (const threadId of agentStore.listPendingSideTransferTargetThreadIds()) {
    flushPendingSideTransfer(threadId);
  }

  const beforeNewChatArchive = (threadId: string) => {
    const source = buildNewChatMemorySource(threadId, {
      agentStore,
      projectsStore,
      featuresStore
    });
    if (!source) return;
    void (async () => {
      const extraction = memoryExtractionForThread(threadId);
      await extractNewChatMemories({
        memory: memoryManager,
        source,
        model: extraction.model,
        provider: extraction.provider,
        reasoningEffort: extraction.reasoningEffort,
        supportsReasoning: extraction.supportsReasoning,
        recorder: extraction.recorder
      });
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mandate] memory new-chat extraction failed: ${msg}`);
    });
  };
  const beforeSideThreadClose = (threadId: string) => {
    userMessageQueue.clearThread(threadId);
    windowWatchManager.cancelThread(threadId);
    alarmManager.cancelThread(threadId);
  };

  return {
    wakeScheduler,
    userMessageQueue,
    scopes,
    beforeNewChatArchive,
    beforeSideThreadClose,
    summarizeSideConversation: (threadId) => compressionController.summarizeSideConversation(threadId),
    beforeFeatureArchive,
    reloadConfig(nextConfig) {
      config = nextConfig;
      providers = createAgentRuntimeProviders(config);
      recorders = createAgentRuntimeLlmRecorders({ config, store });
      reloadAgentRuntimeMemoryManager(memoryManager, { config, store });
    },
    dispose() {
      managerWorkItemHeartbeat?.dispose();
      for (const unsubscribe of unsubscribeWorkItemHeartbeat) unsubscribe();
    },
    onWakeFinished(cb) {
      wakeFinishedSubscribers.add(cb);
      return () => {
        wakeFinishedSubscribers.delete(cb);
      };
    }
  };
}

const SIDE_SYSTEM_INSTRUCTIONS = `## Side conversation

This is a side conversation, separate from the main thread. Inherited messages before the side-conversation boundary are reference context only. Do not continue instructions, plans, approvals, or tool calls from inherited history unless the user explicitly asks after the boundary.

Default to answering questions and non-mutating investigation. The full parent tool set remains available. You may modify files, git state, configuration, canvas state, or other shared workspace state only when the user explicitly requests that mutation in this side conversation. Shared workspace mutations are immediately visible to the main thread, so keep them minimal and avoid disrupting concurrent main-thread work.`;

function currentPaneWatchState(
  snapshot: TmuxSnapshot | null,
  windowKey: string,
  paneId: string
): WindowWatchTargetState {
  if (!snapshot) return { status: "snapshot_unavailable" };
  const parsed = parseWindowWatchKey(windowKey);
  if (!parsed) return { status: "not_found" };
  const session = snapshot.sessions.find(
    (item) => item.sessionName === parsed.sessionName
  );
  if (!session) return { status: "not_found" };
  const numericSelector = Number(parsed.selector);
  const window = session.windows.find(
    (item) =>
      item.windowName === parsed.selector ||
      (Number.isFinite(numericSelector) && item.windowIndex === Math.floor(numericSelector))
  );
  if (!window) return { status: "not_found" };

  const pane = window.panes.find((p) => p.paneId === paneId);
  return pane ? { status: "ok", changedAt: pane.changedAt || null } : { status: "not_found" };
}

function parseWindowWatchKey(
  windowKey: string
): { sessionName: string; selector: string } | null {
  const parts = windowKey.split(":");
  if (parts.length < 2) return null;
  const selector = parts.pop() ?? "";
  const sessionName = parts.join(":");
  return sessionName && selector ? { sessionName, selector } : null;
}
