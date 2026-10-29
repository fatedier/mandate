import type { WaitKind } from "../../shared/thread-dot.js";
import type { MandateStore } from "../app/store.js";
import { logError } from "../platform/logger.js";
import { createWebTools, type WebTools } from "../modules/web/web-tools.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { AgentStore, AgentScope } from "../modules/agent/agent-store.js";
import type { WorkItem, WorkItemStore } from "../modules/agent/work-item-store.js";
import { broadcastWorkItemCreated } from "../modules/agent/work-item-created-broadcast.js";
import { WakeLock } from "../modules/agent/wake-lock.js";
import { WakeScheduler } from "../modules/agent/wake-loop.js";
import { CacheSealer } from "../modules/agent/cache-seal/cache-sealer.js";
import { CacheSealLedger } from "../modules/agent/cache-seal/seal-ledger.js";
import { createSealSender } from "../modules/agent/cache-seal/send-seal.js";
import { AgentUserMessageQueue } from "../modules/agent/user-message-queue.js";
import type { SkillRegistry } from "../modules/skills/skill-registry.js";
import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { GitClient } from "../platform/git/git.js";
import type { PaneRuntimeRegistry } from "./pane-runtime-registry.js";
import type { ThreadArchive } from "../modules/agent/thread-archive.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import { paneReadCursors } from "../modules/panes/pane-read-cursor.js";
import type { LifecyclePublisher } from "./events.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { CanvasStore } from "../modules/canvas/canvas-store.js";
import type { Config } from "../config.js";
import type { ScopeRuntime } from "./scope.js";
import { WindowWatchManager } from "../modules/agent/window-watch-manager.js";
import { AgentAlarmManager } from "../modules/agent/agent-alarm-manager.js";
import { CommandMonitorManager, monitorRunnerFrom } from "../modules/agent/command-monitor-manager.js";
import { noteWorkerMessageToManager } from "./worker-direct-note.js";
import { createPendingMonitorFeed, type AllPendingMonitorsSnapshot, type PendingMonitorsSnapshot } from "../modules/agent/pending-monitors.js";
import { nodeShellCommandRunner, type ShellCommandRunner } from "../platform/process/shell-command-runner.js";
import type { TmuxSnapshot } from "../platform/tmux/tmux-types.js";
import { createAgentCompressionController } from "./agent-compression-controller.js";
import type { ManualCompactionOutcome } from "../modules/agent/compression.js";
import { createAgentRuntimeLlmRecorders } from "./agent-llm-recorders.js";
import { createAgentRuntimeScopes } from "./agent-scopes.js";
import { FeatureRecordStore } from "../modules/plans/record-store.js";
import { PlanStore } from "../modules/plans/plan-store.js";
import { appendPlanReminderIfDue } from "../modules/plans/plan-reminder.js";
import { createAgentRuntimeProviders } from "./agent-providers.js";
import { createAgentModelRouter, threadRouteSources } from "./agent-model-router.js";
import {
  createAgentRuntimeMemoryManager,
  reloadAgentRuntimeMemoryManager
} from "./agent-memory.js";
import { createWindowExtractor } from "./agent-memory-hooks.js";
import { currentPaneName, currentPaneWatchState, parseWindowWatchKey } from "./pane-watch-state.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import { ManagerSweeps } from "./manager-sweeps.js";
import type { ManagerWorkItemHeartbeatTimers } from "./manager-work-item-heartbeat.js";
import { reportWorkerQuestion, reportWorkerSilentStop, reportWorkerWakeEnd, wakeEndStatus } from "./worker-report.js";
import type { StatusHolder } from "../modules/global/thread-status-broadcast.js";
import { toWorkItemDto } from "../modules/agent/work-item-dto.js";
import { relayFeatureMessageReply } from "./feature-message-relay.js";
import { createRetiredThreadGuard } from "./retired-threads.js";
import { HandoffService } from "../modules/global/handoff-service.js";
import { stopOfTarget } from "../modules/global/thread-signals.js";
import { createManagerRequestCheck } from "../modules/manager-checks/request/manager-request-check.js";
import { createManagerStopCheck, type ManagerStopCheck } from "../modules/manager-checks/stop/manager-stop-check.js";
import { createManagerStopCheckStore } from "../modules/manager-checks/stop/store.js";
import { leadWait } from "../../shared/thread-dot.js";
import { formatThreadNoticeText, threadNoticeMetadata, type ThreadNotice } from "../../shared/thread-notice.js";
import { mailboxWakeReason, startupMailboxWakeReason } from "./mailbox-wake-reason.js";
import { createUpwardInbox, type UpwardRoute } from "../modules/agent/upward-inbox.js";
import { displayGlobalAgentName } from "../../shared/global-agent-name.js";
import { errorText } from "../../shared/error-text.js";
import type { PagePublisher } from "../modules/page/page-publisher.js";
import type { PageAnswers } from "../modules/page/page-answers.js";
import { createSubagentService, type PageRunHooks, type SubagentService } from "./subagents.js";
import { createBackgroundCommandService, type BackgroundCommandService } from "./background-commands.js";
import { listTasksFor, tasksContext, type TaskList } from "./task-list.js";
import { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import { managerStopCheckChain } from "../config/model-resolution.js";
import { IdleCompactor } from "../modules/agent/idle-compaction/idle-compactor.js";
import { dropIdleClockOnVoice, idleCompactorDeps } from "./idle-compactor-deps.js";
import { localTimeZone } from "../platform/time/agent-time.js";
import { withMessageTimes } from "../modules/agent/system-prompt.js";
import { createThreadModels, type ThreadModels } from "./thread-models.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";

/** How long a thread's stop notice waits for the manager stop check's verdict. */
const STOP_NOTICE_WAIT_MS = 10_000;

/** A follow-up step the database refused (runStep) is tried again after each
 *  of these (about two minutes in all), as a release follow-up is. */
const STEP_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 16000, 30000, 60000];

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
  /** Archives a thread with its workers: the global agent's archive_thread. */
  threadArchive?: Pick<ThreadArchive, "archive">;
  /** What runs background commands; the login-shell runner unless a test's. */
  commandRunner?: ShellCommandRunner;
  /** web_search and web_fetch; built on the live config unless a test's. */
  web?: WebTools;
  /** The waits before each new try of a follow-up step the database refused
   *  (a worker's reply and report, what follows a message's landing); a test
   *  passes short ones. */
  stepRetryDelaysMs?: readonly number[];
  /** The managers' sweep clock; a test passes its own. */
  managerSweep?: { delayMs?: number; timers?: ManagerWorkItemHeartbeatTimers };
  /** The status snapshot, built after the runtime: poked when a thread is
   *  let go after its turn, which no event announces. */
  status?: Pick<StatusHolder, "poke">;
  /** Your agent's page: its folder, and what publishes it when a writer
   *  ends (its turn, or a page subagent). Without it there are no page
   *  subagents. */
  page?: {
    dir: string;
    publisher: Pick<PagePublisher, "afterAgentTurn" | "afterSubagent" | "writeStarted">;
    /** What the user gave on the page: read once its note reaches Your agent. */
    answers?: Pick<PageAnswers, "markDelivered" | "announce">;
  };
  /** The zone agents read times in; the machine's unless a test's. */
  timeZone?: string;
}

export interface AgentRuntime {
  wakeScheduler: WakeScheduler;
  /** A compaction started by hand (the /compact command): start it, and
   *  whether one has the thread now. */
  compaction: {
    start(threadId: string): ManualCompactionOutcome;
    inFlight(threadId: string): boolean;
  };
  userMessageQueue: AgentUserMessageQueue;
  /** What a conversation holds behind its running turn changed. Such a
   *  message already answers the conversation's questions, so whoever shows
   *  them hears of it here; one that lands is an appended message. Returns
   *  the way to stop listening. */
  onUserQueueChanged(listener: (threadId: string) => void): () => void;
  /** Per-scope runtime objects, keyed by AgentScope. agents-api uses these
   *  to mount HTTP routes generically and to reach scope-specific behavior
   *  (verifyScopeId for the route gate). */
  scopes: Record<AgentScope, ScopeRuntime>;
  /** Called before a manager thread is archived: its window's memory. */
  beforeThreadArchive(threadId: string): void;
  /** Whether work the runtime holds for a thread will still write to it: a
   *  turn (or one stopping), a compaction, memories still being drawn from
   *  its window, a subagent of its still queued or running, a manager stop check
   *  under way. What a delete waits on. */
  isThreadWorking(threadId: string): boolean;
  /** Frees what a thread holds before it is archived: its subagents (stopped
   *  unannounced), queued user messages, watches, alarms, a manager thread's
   *  sweep, and open handoffs to it. */
  releaseThreadResources(threadId: string): void;
  /** Called by feature archive paths before the feature thread is archived:
   *  its handoffs, its worker's subagents, its memory. */
  beforeFeatureArchive(featureId: string): void;
  /** What a thread's agent is still waiting on: its pending monitors, and its
   *  subagents still queued or running. */
  pendingMonitors(threadId: string): PendingMonitorsSnapshot;
  /** A thread's model as its composer shows and sets it. */
  threadModels: ThreadModels;
  /** Whether the model a thread runs on first takes this input. */
  supportsInputForThread(threadId: string, input: ModelInputType): boolean;
  /** Whether a conversation is at work (a turn, or a message to start one),
   *  and what it sleeps on: what Home's and the page's states are read from. */
  threadActivity: { isBusy(threadId: string): boolean; waitKind(threadId: string): WaitKind | null };
  /** Every thread that waits on something, as of one revision. */
  allPendingMonitors(): AllPendingMonitorsSnapshot;
  /** The models whose cache seal is paused (Activity's note). */
  cacheSealPauses(): import("../modules/agent/cache-seal/seal-ledger.js").SealPause[];
  /** What the global agent handed off for the user. */
  handoffs: HandoffService;
  /** The manager stop check: what a stopped thread's latest reply leaves the user. */
  managerStopCheck: ManagerStopCheck;
  /** Subagents: what the `subagent` tool starts, and `stop_task` or the user stops. */
  subagents: SubagentService;
  /** Background commands: what bash runs in the background, and moves there
   *  at its timeout; `stop_task` or the user stops them. */
  commands: BackgroundCommandService;
  /** The runs they are recorded as: a thread's task list reads them. */
  backgroundTasks: BackgroundTaskStore;
  /** Refresh model/provider-dependent runtime handles after config.json changes. */
  reloadConfig(config: Config): void;
  dispose(): void;
}

/** How often the subagent service puts right what refused writes left undone. */
const SUBAGENT_RECONCILE_MS = 30_000;

/** Wire up the entire agent stack: per-scope runtimes (registries +
 *  dispatchers + prompts), the WakeScheduler, and the two cross-cutting
 *  bridges (analyzer→agent, dispatch→handoff). */
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
  const planStore = new PlanStore(store.db);
  // The runtime's one task store, made before the model router, which reads
  // it: a subagent's thread routes as its parent's.
  const backgroundTasks = new BackgroundTaskStore(store.db);
  // What a conversation's tools and its context after a compaction say of its
  // tasks; a command's counts are read from its service, made below.
  const taskList: TaskList = {
    list: (threadId) => listTasksFor({ tasks: backgroundTasks, stats: (taskId) => commands.stats(taskId) }, threadId),
    kindOf: (taskId) => backgroundTasks.get(taskId)?.kind ?? null
  };

  let providers = createAgentRuntimeProviders(config);
  let recorders = createAgentRuntimeLlmRecorders({ config, store });
  const wakeLock = new WakeLock();
  let managerSweeps: ManagerSweeps | null = null;
  agentStore.recoverInterruptedWakes("Mandate server restarted before this wake finished.", (thread) => {
    if (thread.scope === "manager" || thread.scope === "global") return true;
    // A subagent's run is never resumed: its task ends interrupted and its
    // parent is told (subagents.recoverAtStartup, below).
    if (thread.scope === "subagent") return false;
    const feature = thread.scopeId ? featuresStore.getById(thread.scopeId) : null;
    const project = feature ? projectsStore.getById(feature.projectId) : null;
    return Boolean(feature && !feature.archivedAt && project && !project.archivedAt);
  });

  // Forward declaration: scopes' onWake closures need wakeScheduler.wake,
  // but the scheduler needs the scopes (for prompt + dispatcher). Capture
  // the variable; assign after both sides are constructed.
  let wakeScheduler!: WakeScheduler;
  const scheduleWake = (
    threadId: string,
    reason: Parameters<typeof wakeScheduler.wake>[1],
    triggerMessageId: string | null
  ) => wakeScheduler.wake(threadId, reason, triggerMessageId);
  /** A turn holds the thread, or its wake's row still runs (between the two
   *  as a wake starts or ends). */
  const turnRunning = (threadId: string): boolean =>
    wakeScheduler.isThreadBusy(threadId) || Boolean(wakeScheduler.getRunningWakeForThread(threadId));
  // Every message between levels goes in here; its kind decides whether it
  // wakes its receiver. A wake for mail: a refused one is tried again.
  const upwardInbox = createUpwardInbox({
    agentStore,
    sse,
    busy: turnRunning,
    wake: (threadId, source) => { wakeScheduler.wakeForMail(threadId, mailboxWakeReason([source])); }
  });
  const postThreadNotice = (globalThreadId: string, notice: ThreadNotice, lastReply: string | null, route: UpwardRoute) => upwardInbox.post({
    to: globalThreadId,
    ...route,
    source: "thread-notice",
    sourceThreadId: notice.targetThreadId,
    content: { type: "text", text: formatThreadNoticeText(notice, lastReply), metadata: threadNoticeMetadata(notice) }
  });
  // A step that follows something already done (a worker's reply and report
  // after its turn, what follows a message's landing), run on its own: one
  // the database refused does not undo or skip the rest, and is tried again
  // while refused. Each is one write, so a try again never does it twice.
  const stepRetries = new Set<ReturnType<typeof setTimeout>>();
  let stepsDisposed = false;
  const runStep = (who: string, step: (attempt: number) => void, attempt = 0): void => {
    try {
      step(attempt);
    } catch (err) {
      logError(who, err);
      const delays = deps.stepRetryDelaysMs ?? STEP_RETRY_DELAYS_MS;
      if (stepsDisposed || attempt >= delays.length) return;
      const timer = setTimeout(() => {
        stepRetries.delete(timer);
        runStep(who, step, attempt + 1);
      }, delays[attempt]);
      timer.unref?.();
      stepRetries.add(timer);
    }
  };
  // Assigned right after the queue, which tells it about every message it
  // appends: a handoff learns its message id when the message lands.
  let noteAppended: HandoffService["noteAppended"] | null = null;
  const queueChanged = new Set<(threadId: string) => void>();
  const userMessageQueue = new AgentUserMessageQueue({
    agentStore,
    sse,
    wakeScheduler: {
      wake: scheduleWake,
      isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
      getRunningWakeForThread: (threadId) => wakeScheduler.getRunningWakeForThread(threadId),
      retryFollowUp: (threadId, who, err) => wakeScheduler.retryFollowUp(threadId, who, err)
    },
    onMessageAppended: (threadId, message) => noteAppended?.(threadId, message),
    onQueueChanged: (threadId) => { for (const listener of queueChanged) listener(threadId); },
    onQuestionSettled: (threadId, question, settled) => handoffs.noteQuestionSettled(threadId, question, settled)
  });
  // What the user says while a conversation's turn runs answers its questions
  // from the moment it is taken in, not when the turn reads it.
  agentStore.setQueuedAnswers((threadId) => userMessageQueue.queuedAnswers(threadId));
  // Whether a conversation is at work, or will wake by itself: what "the
  // thread has stopped" and "the thread rests" are read from.
  const threadActivity = {
    // A thread whose follow-up is to be tried again is about to start what queued.
    isBusy: (id: string) => turnRunning(id) || userMessageQueue.pendingCount(id) > 0
      || wakeScheduler.hasFollowUpDue(id),
    waitKind: (id: string) => leadWait(monitorFeed.snapshot(id).monitors)
  };
  const handoffs = new HandoffService({
    db: store.db,
    agentStore,
    featuresStore,
    queue: userMessageQueue,
    emit: (handoff) => sse.emit(SSE_EVENTS.globalHandoffUpdated, { handoff }),
    agentName: () => displayGlobalAgentName(config.agent.globalAgentName),
    stopOf: (threadId) => stopOfTarget({ agentStore, featuresStore, workStore, planStore, ...threadActivity }, threadId),
    // A thread's stop notice says what the manager stop check found, waiting for it
    // up to STOP_NOTICE_WAIT_MS; with the check off it goes at once.
    stopVerdict: (threadId) => managerStopCheck.verdictFor(threadId, STOP_NOTICE_WAIT_MS),
    // Ended after the verdict, on its own: tried again here when refused.
    later: (who, step) => runStep(who, () => step()),
    // As a worker's report reaches its manager: through the inbox, whose
    // kind decides the wake. A busy or held conversation takes it between
    // steps, or is woken for it when released (mailboxWakeReason). A note
    // wakes nobody: resting, it lands now, where the user sees it; mid-turn,
    // at its next step.
    notify: (globalThreadId, notice, lastReply, route) => {
      postThreadNotice(globalThreadId, notice, lastReply, route).wake();
    },
    // A wait's end: its notice written with it, the wake asked for after.
    recordNotice: (globalThreadId, notice, lastReply, route) => postThreadNotice(globalThreadId, notice, lastReply, route).wake
  });
  noteAppended = (threadId, message) => {
    // Each on its own, after the message is in: the sender is not told a
    // message it wrote failed (a resend would double it) when a write that
    // follows it is refused; that one is tried again.
    runStep(`the handoff of message ${message.id}`, (attempt) => {
      handoffs.noteAppended(threadId, message);
      // Marked late, its target may have stopped meanwhile, or ended a turn
      // working on: that release judged the handoff while it was still
      // queued.
      if (attempt > 0) {
        handoffs.noteSettled(threadId);
        managerRequestCheck.noteTurnEnded(threadId);
        managerStopCheck.noteSettled(threadId);
      }
    });
    // What the user tells a worker, its manager reads too.
    runStep(`the manager's copy of message ${message.id}`, () => noteWorkerMessageToManager({
      agentStore, featuresStore, inbox: upwardInbox
    }, threadId, message));
  };

  const drainMailboxIntoThread = (threadId: string, wakeId: string) => {
    const answers = deps.page?.answers;
    // The mail taken in, and what the user gave on the page that it carried
    // marked read, in one write: never a note in without its answer read.
    const { mailboxMessages, read } = store.db.transaction(() => {
      const mailboxMessages = agentStore.drainMailboxToMessages(threadId, wakeId);
      const read = answers && mailboxMessages.some((message) => message.source === "page-input")
        ? answers.markDelivered(agentStore.listMailboxMessagesDeliveredToWake(wakeId).filter((item) => item.source === "page-input").map((item) => item.id))
        : [];
      return { mailboxMessages, read };
    }).immediate();
    for (const message of mailboxMessages) {
      sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message });
    }
    answers?.announce(read);
  };
  /** What queued behind a released thread, the first that starts a wake. */
  const startWhatQueuedBehind = async (threadId: string): Promise<void> => {
    if (userMessageQueue.flushIfIdle(threadId)) return;
    if (flushMailboxWakeIfIdle(threadId)) return;
    if (await windowWatchManager.flushPendingWake(threadId)) return;
    if (await commandMonitorManager.flushPendingWake(threadId)) return;
    if (agentStore.getThreadById(threadId)?.scope === "manager") {
      managerSweeps?.flushAfterRelease(threadId);
    }
  };
  const flushMailboxWakeIfIdle = (threadId: string): string | null => {
    if (turnRunning(threadId))
      return null;
    const sources = agentStore.queuedMailboxSources(threadId);
    if (sources.length === 0) return null;
    return wakeScheduler.wake(threadId, mailboxWakeReason(sources), null);
  };
  // What each thread's agent is still waiting on, for its chat. Read through
  // the managers built just below; it is only asked once a monitor changes
  // or a page reads the thread, both after the runtime is built.
  const monitorFeed = createPendingMonitorFeed({
    sse,
    listWatches: (threadId) => windowWatchManager.list(threadId),
    listCommands: (threadId) => commandMonitorManager.list(threadId),
    // The open tasks are few (six running per conversation, and its queue): a
    // conversation's whole history of tasks is not read for this. A page
    // subagent wakes nobody, so Your agent does not wait on it.
    listTasks: (threadId) => backgroundTasks.listOpen().filter((task) => task.parentThreadId === threadId && task.type !== "page"),
    listAlarms: (threadId) => alarmManager.listWaitedOn(threadId),
    threadIds: () => [
      ...windowWatchManager.threadIds(),
      ...commandMonitorManager.threadIds(),
      ...backgroundTasks.listOpen().map((task) => task.parentThreadId),
      ...alarmManager.threadIds()
    ],
    threadScope: (threadId) => {
      const thread = agentStore.getThreadById(threadId);
      return thread ? { scope: thread.scope, scopeId: thread.scopeId } : null;
    }
  });
  const windowWatchManager = new WindowWatchManager({
    db: store.db,
    onPendingChanged: (threadId) => monitorFeed.changed(threadId),
    // The guard is created just below; this runs only when a watch is
    // registered or fires, both after the runtime is built.
    isThreadRetired: (threadId) => retiredThreads.isThreadRetired(threadId),
    agentStore,
    sse,
    onWake: (threadId, reason, triggerMessageId) =>
      scheduleWake(threadId, reason, triggerMessageId),
    isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
    retryRefused: (threadId, who, err) => wakeScheduler.retryFollowUp(threadId, who, err),
    getPaneState: (windowKey, paneId) => currentPaneWatchState(getSnapshot(), windowKey, paneId),
    paneName: (windowKey, paneId) => currentPaneName(getSnapshot(), deps.paneMetadata, windowKey, paneId),
    capturePaneTail: async (windowKey, paneId, lines) => {
      const parsed = parseWindowWatchKey(windowKey);
      if (!parsed) return null;
      const project = projectsStore.getActiveByTmuxSessionName(parsed.sessionName);
      if (!project) return null;
      return paneRuntimes.forProject(project.id).readScrollback(paneId, { tailLines: lines });
    }
  });
  // Called only when a wake is refused, by which time every manager exists.
  const retiredThreads = createRetiredThreadGuard({
    agentStore,
    featuresStore,
    backgroundTasks,
    cancelThreadWakeSources: (threadId) => {
      alarmManager.cancelThread(threadId);
      windowWatchManager.cancelThread(threadId);
      commandMonitorManager.cancelThread(threadId);
    },
    // Read when a wake is refused: the service is made right after the
    // scheduler, before the start-up wakes, the first that can be refused.
    stopBackgroundTasks: (parentThreadId) => {
      subagents.stopAllFor(parentThreadId);
      commands.stopAllFor(parentThreadId);
    }
  });
  // The zone agents read times in: their messages', digests' and alarms'.
  const timeZone = deps.timeZone ?? localTimeZone();
  const alarmManager = new AgentAlarmManager({
    timeZone,
    db: store.db,
    agentStore,
    sse,
    onWake: (threadId, reason, triggerMessageId) => scheduleWake(threadId, reason, triggerMessageId),
    isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
    isThreadRetired: retiredThreads.isThreadRetired,
    onPendingChanged: (threadId) => monitorFeed.changed(threadId),
    // Its waits judged again: nothing wakes the thread for its alarm now.
    onWakeAbandoned: (threadId) => {
      handoffs.noteSettled(threadId);
      managerStopCheck.noteSettled(threadId);
    }
  });
  // Delivers fired monitors left from before a restart once this returns, by
  // which time the wake scheduler exists.
  const commandMonitorManager = new CommandMonitorManager({
    db: store.db,
    agentStore,
    sse,
    onPendingChanged: (threadId) => monitorFeed.changed(threadId),
    runner: monitorRunnerFrom(nodeShellCommandRunner),
    onWake: (threadId, reason, triggerMessageId) => scheduleWake(threadId, reason, triggerMessageId),
    isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
    retryRefused: (threadId, who, err) => wakeScheduler.retryFollowUp(threadId, who, err),
    isThreadRetired: retiredThreads.isThreadRetired
  });
  const memoryManager = createAgentRuntimeMemoryManager({ config, store });
  // Which model and recorder each call a thread makes uses (its scope's; a
  // subagent's the subagent route, or while that is unset its parent's, found
  // through its task), read through getters so a config reload routes the
  // next call by the new providers.
  const modelRouter = createAgentModelRouter({
    config: () => config,
    providers: () => providers,
    recorders: () => recorders,
    store,
    ...threadRouteSources({ agentStore, backgroundTasks })
  });
  // A request of Your agent's that a busy thread says is done ends then,
  // not when the whole thread stops: judged after each manager turn.
  const managerRequestCheck = createManagerRequestCheck({
    agentStore,
    handoffs,
    stopOf: (threadId) => stopOfTarget({ agentStore, featuresStore, workStore, planStore, ...threadActivity }, threadId),
    candidates: () => modelRouter.managerRequestCheck()
  });
  // What a stopped thread's latest reply leaves the user, judged once per
  // reply; a verdict turns the thread blue while it stands.
  const managerStopCheck = createManagerStopCheck({
    agentStore,
    featuresStore,
    store: createManagerStopCheckStore(store.db),
    stopOf: (threadId) => stopOfTarget({ agentStore, featuresStore, workStore, planStore, ...threadActivity }, threadId),
    candidates: () => modelRouter.managerStopCheck(),
    onVerdict: (threadId, verdict) => {
      deps.status?.poke();
      // What a round the user drove there left, told to Your agent without a
      // wake; on its own, so a refusal costs no waiting notice its verdict.
      runStep(`the quiet notice of thread ${threadId}`, () => handoffs.noteVerdict(threadId, verdict));
    },
    // Off (or with no model), it is as if it were not there: no blue.
    on: () => managerStopCheckChain(config).length > 0
  });
  const {
    compressionForThread,
    memoryExtraction,
    supportsInputForScope,
    supportsInputForThread,
    supportsToolResultImagesForThread
  } = modelRouter;
  // Memories from the messages leaving a model's context, in the background
  // on memory extraction's route (createWindowExtractor).
  const windowExtractor = createWindowExtractor({
    agentStore, projectsStore, featuresStore,
    memory: memoryManager,
    records: new FeatureRecordStore(store.db),
    route: () => memoryExtraction(),
    budgetTokens: () => config.agent.compressionThresholdTokens,
    sse
  });
  const extractWindow = windowExtractor.extractWindow;
  const beforeFeatureArchive = (featureId: string) => {
    const workerThread = agentStore.getThreadByScope("worker", featureId);
    if (!workerThread) return;
    handoffs.failOpenForThread(workerThread.id, "the worker was archived");
    // Its subagents and commands stop with it, and nobody is told: the
    // conversation that would read their results is being archived.
    subagents.stopAllFor(workerThread.id);
    commands.stopAllFor(workerThread.id);
    extractWindow(workerThread.id, "worker_archive", agentStore.getActiveMessages(workerThread.id));
  };

  // Workers whose running turn already told their manager something (a
  // question it wrote into its plan): its end is then no silent stop.
  const toldMidTurn = new Set<string>();
  // How a worker's state reaches the thread that owns it: at the end of each
  // of its turns, and the moment it writes a question into its plan.
  const workerReportDeps = {
    agentStore,
    featuresStore,
    projectsStore,
    workStore,
    planStore,
    inbox: upwardInbox,
    onWorkItemChanged: (item: WorkItem) => sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(item) }),
    onOwnerChanged: (featureId: string, ownerThreadId: string) =>
      deps.publishLifecycle?.({ type: "featureOwnerChanged", data: { id: featureId, ownerThreadId } })
  };

  const scopes = createAgentRuntimeScopes({
    verdictOf: (threadId) => managerStopCheck.current(threadId),
    timeZone,
    onWorkerQuestion: (featureId, questions) => {
      if (reportWorkerQuestion(workerReportDeps, { featureId, questions })) toldMidTurn.add(featureId);
    },
    // The agent hears of a question a thread it waits on asks the user as it is asked.
    onQuestionAsked: (threadId, question) => handoffs.noteQuestion(threadId, question),
    // And when it takes one back: whoever heard of it hears that too.
    onQuestionWithdrawn: (threadId, question) => handoffs.noteQuestionSettled(threadId, question, { how: "withdrawn" }),
    threadActivity,
    config,
    getConfig: () => config,
    store,
    agentStore,
    projectsStore,
    featuresStore,
    workStore,
    backgroundTasks,
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
    windowWatchManager,
    commandMonitorManager,
    alarmManager,
    memoryManager,
    canvasStore: deps.canvasStore,
    getWakeScheduler: () => wakeScheduler,
    // Reads the binding at call time: the heartbeat is constructed below, after
    // the scopes it hands this to.
    sweepController: {
      endSweep: (threadId) => managerSweeps?.endSweep(threadId),
      isEnded: (threadId) => managerSweeps?.isEnded(threadId) ?? false
    },
    userMessageQueue,
    handoffs,
    // The service is made right after the scheduler, below; a tool call
    // reaches it only once the runtime is built.
    subagents: {
      start: (input) => subagents.start(input),
      stop: (taskId, by, requesterThreadId) => subagents.stop(taskId, by, requesterThreadId)
    },
    answeringPerson: (threadId) => wakeScheduler.isAnsweringPerson(threadId),
    // Made with the subagents, below, as they are.
    commands: {
      start: (input) => commands.start(input),
      adopt: (input) => commands.adopt(input),
      stop: (taskId, by, requesterThreadId) => commands.stop(taskId, by, requesterThreadId)
    },
    taskList,
    ...(deps.commandRunner ? { shellRunner: deps.commandRunner } : {}),
    // Read through the live config: a change on the Settings page reaches the
    // next model step.
    web: deps.web ?? createWebTools({ getConfig: () => config, store }),
    ...(deps.page ? { pageDir: deps.page.dir } : {}),
    threadArchive: deps.threadArchive,
    beforeFeatureArchive,
    supportsInputForScope,
    supportsInputForThread,
    supportsToolResultImagesForThread
  });

  const scopeForThread = (threadId: string): ScopeRuntime | null => {
    const t = agentStore.getThreadById(threadId);
    return t ? scopes[t.scope] : null;
  };

  // Each scope's prompt, ended by how the thread's messages carry times.
  const buildSystemPromptForThread = async (threadId: string) =>
    withMessageTimes((await scopeForThread(threadId)?.buildSystemPrompt(threadId)) ?? "", timeZone);
  const buildRuntimeContextForThread = async (threadId: string) => {
    return (await scopeForThread(threadId)?.buildRuntimeContext?.(threadId)) ?? null;
  };
  const buildInitialContextForThread = async (threadId: string) => {
    return (await scopeForThread(threadId)?.buildInitialContext?.(threadId)) ?? null;
  };
  // The cache seal: a Claude wake step writes its
  // messages for five minutes and a quiet thread is sealed for an hour. Its
  // state lives in memory: a restart starts every model afresh. The switch
  // is read through the live config.
  // Idle compaction: a long thread is compacted a few
  // minutes before its prompt cache expires, on the warm model. Fed by the
  // sealer; its settings and each model's typed lifetime read live.
  const idleCompactor = new IdleCompactor(idleCompactorDeps({
    config: () => config,
    agentStore,
    featuresStore,
    alarms: alarmManager,
    stepPromptFor: (threadId) => wakeScheduler.stepPromptFor(threadId, { pendingResults: false }),
    compact: (threadId, opts) => compressionController.compactIdle(threadId, opts)
  }));
  const stopVoiceDrops = dropIdleClockOnVoice(sse, idleCompactor);
  const cacheSealer = new CacheSealer({
    enabled: () => config.agent.cacheSealEnabled === true,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
    // A reply whose tools still run is sealed whole, as the next step sends it.
    stepPromptFor: (threadId) => wakeScheduler.stepPromptFor(threadId, { pendingResults: true }),
    threadSealable: (threadId) => {
      const thread = agentStore.getThreadById(threadId);
      return thread !== null && !thread.archivedAt;
    },
    sendSeal: createSealSender({
      recorderFor: (candidate) => candidate.llmCallRecorder ?? null,
      threadScope: (threadId) => agentStore.getThreadById(threadId)?.scope ?? null,
      now: () => Date.now()
    }),
    ledger: new CacheSealLedger(() => Date.now()),
    idle: idleCompactor
  });
  const compressionController = createAgentCompressionController({
    config,
    getConfig: () => config,
    store,
    agentStore,
    sse,
    compressionForThread,
    buildSystemPrompt: buildSystemPromptForThread,
    supportsInputForThread,
    extractWindow,
    // Same singleton the pane tool pack hands read_pane; compression drops a
    // thread's cursors because it may have summarized away the messages that
    // held those pane lines.
    cursors: paneReadCursors,
    // A compaction started by hand holds the thread as a turn does. The
    // scheduler is assigned just below; this reads it when called.
    holdThread: (threadId) => wakeScheduler.holdThread(threadId),
    // A compaction is sent on the prompt the next step would send, so it
    // reads that step's prompt cache. Read from the scheduler when called.
    stepPromptForThread: (threadId) => wakeScheduler.stepPromptFor(threadId),
    cacheSeal: cacheSealer,
    timeZone
  });

  wakeScheduler = new WakeScheduler({
    agentStore,
    isThreadRetired: retiredThreads.isThreadRetired,
    onRetiredWakeRefused: retiredThreads.onRetiredWakeRefused,
    ready: deps.ready,
    lock: wakeLock,
    buildSystemPrompt: buildSystemPromptForThread,
    buildInitialContext: buildInitialContextForThread,
    // Read only for a first context: after a compaction, what still runs.
    buildTasksContext: (threadId) => tasksContext(taskList.list(threadId)),
    buildRuntimeContext: buildRuntimeContextForThread,
    // Your agent's digest is large and changes a little at a time: after its
    // window's full digest it hears the changes.
    contextChangesOnly: (threadId) => agentStore.getThreadById(threadId)?.scope === "global",
    timeZone,
    // A scope may give each thread its own: a subagent's is its parent's set.
    toolDispatcherForThread: (threadId) => {
      const scope = scopeForThread(threadId) ?? scopes.worker;
      return scope.dispatcherForThread?.(threadId) ?? scope.wrappedDispatcher;
    },
    llmModel: providers.workerProvider.model,
    contextBudgetTokens: () => compressionController.contextBudgetTokens,
    llmForThread: modelRouter.llmForThread,
    // A subagent's steps are filed apart in Activity: their own purpose (a
    // page subagent's apart again), with the conversation it works for.
    stepRecordingForThread: (threadId) => {
      const thread = agentStore.getThreadById(threadId);
      const task = thread?.scope === "subagent" && thread.scopeId ? backgroundTasks.get(thread.scopeId) : null;
      return task
        ? { purpose: task.type === "page" ? "page_subagent_step" : "subagent_step", metadata: { parentThreadId: task.parentThreadId } }
        : null;
    },
    supportsInputForThread,
    supportsToolResultImagesForThread,
    sse,
    cacheSeal: cacheSealer,
    buildToolScope: (threadId) => {
      const scope = scopeForThread(threadId);
      if (!scope) throw new Error(`thread not found: ${threadId}`);
      return scope.buildToolScope(threadId);
    },
    preWakeHook: async (threadId, info) => {
      if (agentStore.getThreadById(threadId)?.scope === "manager") {
        managerSweeps?.noteWakeStarted(
          threadId,
          info.reason === "work-item-heartbeat"
          || agentStore.getWakeById(info.wakeId)?.metadata?.recovery?.originalReason === "work-item-heartbeat"
        );
      }
      drainMailboxIntoThread(threadId, info.wakeId);
    },
    preStepHook: (threadId, info) => {
      userMessageQueue.flushQueuedIntoThread(threadId);
      drainMailboxIntoThread(threadId, info.wakeId);
      const thread = agentStore.getThreadById(threadId);
      // Worker threads only.
      if (thread?.scope === "worker" && thread.scopeId) {
        appendPlanReminderIfDue({ agentStore, planStore, sse }, { threadId, wakeId: info.wakeId, featureId: thread.scopeId });
      }
    },
    beforeModelCallHook: (threadId, info) =>
      compressionController.beforeModelCallHook(threadId, info),
    postWakeHook: async (threadId, info) => {
      // Whether this turn told the worker's manager anything (a reply to its
      // message, a report of a new state): a quiet stop is one that did not.
      // A write that was refused and will be tried again counts as told: its
      // retry wakes the manager, and a sweep beside it would wake it twice.
      let toldManager = false;
      // Where the turn's reply went up as its answer to a manager's message:
      // a report to that thread does not carry it again. Refused and to be
      // tried again counts as gone everywhere: the retry sends it.
      let relayedTo: (threadId: string) => boolean = () => false;
      runStep(`the reply after ${threadId}'s turn`, () => {
        try {
          const replies = relayFeatureMessageReply({
            agentStore,
            featuresStore,
            // A refused wake for a reply is tried again, and the callers
            // after it still get theirs.
            inbox: upwardInbox
          }, {
            threadId,
            wakeId: info.wakeId,
            status: info.status
          });
          if (replies.length > 0) {
            toldManager = true;
            const to = new Set(replies.map((reply) => reply.threadId));
            relayedTo = (target) => to.has(target);
          }
        } catch (err) {
          toldManager = true;
          relayedTo = () => true;
          throw err;
        }
      });
      runStep(`the report after ${threadId}'s turn`, (attempt) => {
        // Tried again after a newer turn of the worker ended: that turn
        // reported its own state, which this one's must not overwrite.
        if (attempt > 0 && agentStore.getLatestWakeForThread(threadId)?.id !== info.wakeId) return;
        try {
          if (reportWorkerWakeEnd(workerReportDeps, {
            threadId,
            status: wakeEndStatus(agentStore, info.wakeId, info.status),
            errorMessage: agentStore.getWakeById(info.wakeId)?.errorMessage ?? null,
            lastTurn: { wakeId: info.wakeId, relayedTo }
          })) toldManager = true;
        } catch (err) {
          toldManager = true;
          throw err;
        }
      });
      // Whatever a worker's turn left, its manager's sweep looks again in its
      // interval: a turn that ends with steps left and nothing set to wake it
      // writes no work item, so nothing else would set the sweep going.
      // A turn that stopped quietly (steps left, nothing set to wake it,
      // nothing said to the manager) tells the manager so now, with its last
      // reply: stalled is a state the turn's end already shows, and the
      // interval would only be the time until someone notices. Told, the
      // sweep keeps its interval: the manager is woken once.
      const ended = agentStore.getThreadById(threadId);
      const endedFeature = ended?.scope === "worker" ? ended.scopeId : null;
      const askedMidTurn = endedFeature ? toldMidTurn.delete(endedFeature) : false;
      // On its own: refused, the sweep below is still armed, the safety net.
      runStep(`the silent-stop report after ${threadId}'s turn`, (attempt) => {
        if (attempt > 0 && agentStore.getLatestWakeForThread(threadId)?.id !== info.wakeId) return;
        if (!endedFeature || info.status !== "finished" || toldManager || askedMidTurn) return;
        if (workStore.isStalled(endedFeature)) reportWorkerSilentStop(workerReportDeps, { threadId, wakeId: info.wakeId });
      });
      runStep(`the sweep after ${threadId}'s turn`, (attempt) => {
        // Tried again after a newer turn of the worker ended: that turn
        // settled the sweep for the state it left.
        if (attempt > 0 && agentStore.getLatestWakeForThread(threadId)?.id !== info.wakeId) return;
        if (endedFeature) managerSweeps?.notifyWorkerChanged(endedFeature);
      });
      // A subagent's one wake ended: its run's outcome and reply, and its
      // result to its parent.
      const endedScope = agentStore.getThreadById(threadId)?.scope;
      if (endedScope === "subagent") {
        subagents.onChildWakeEnded(threadId, { wakeId: info.wakeId, status: info.status });
      }
      // Your agent's turn ended, however it ended: what it edited on its page
      // is published. A page that cannot be published never fails the turn.
      if (endedScope === "global" && deps.page) {
        try {
          deps.page.publisher.afterAgentTurn();
        } catch (err) {
          console.warn(`[page] publishing after Your agent's turn failed: ${errorText(err)}`);
        }
      }
    },
    afterWakeReleasedHook: async (threadId) => {
      try {
        await startWhatQueuedBehind(threadId);
        // Whatever started makes the thread busy; then nothing has stopped. A
        // worker's report to its manager started the manager's turn before
        // this thread was released (postWakeHook). One that threw (a write the
        // database refused) is tried again, and that try settles the waits.
        handoffs.noteSettled(threadId);
        managerRequestCheck.noteTurnEnded(threadId);
        managerStopCheck.noteSettled(threadId);
      } finally {
        deps.status?.poke();
      }
    },
    // Its last try failed too: nothing more is coming, so the waits are
    // settled as the thread now stands.
    onFollowUpAbandoned: (threadId) => {
      handoffs.noteSettled(threadId);
      managerStopCheck.noteSettled(threadId);
      deps.status?.poke();
    },
    llmCallRecorder: recorders.workerWakeRecorder
  });

  // Subagents: one bounded job each, in a hidden child thread of its own.
  // Made right after the scheduler and before the start-up wakes below,
  // which can reach it.
  const subagents = createSubagentService({
    db: store.db,
    tasks: backgroundTasks,
    agentStore,
    featuresStore,
    sse,
    wake: (threadId, reason, triggerMessageId) => wakeScheduler.wake(threadId, reason, triggerMessageId),
    cancelWake: (wakeId) => wakeScheduler.cancelWake(wakeId),
    runningWakeOf: (threadId) => wakeScheduler.getRunningWakeForThread(threadId),
    isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
    // The child is told where its shell starts: where its parent's does.
    workingDirOf: (parent) => {
      try {
        const scope = scopes[parent.scope].buildToolScope(parent.id);
        return scope.kind === "worker" ? (scope.feature.workingDir ?? scope.project.workingDir) : (scope.managerDir || null);
      } catch {
        // A worker whose feature is gone: nothing to say.
        return null;
      }
    },
    // Its page, the sidebar and whoever asks whether it will wake hear it.
    onTasksChanged: (parentThreadId) => monitorFeed.changed(parentThreadId),
    ...(deps.page ? { page: pageRunHooks(deps.page.publisher) } : {})
  });
  // What a write the database refused left undone (an outside writer held
  // it past the busy timeout) is put right now and then: a run left running
  // after its wake ended, a child never woken, a parent never woken for its
  // result. A refused end step also asks for it at once (the service).
  // And now and then a command whose conversation went away by a path that
  // stopped nothing (a project's archive, an agent's own write) is stopped.
  const subagentReconcile = setInterval(() => {
    subagents.reconcile();
    commands.sweep();
  }, SUBAGENT_RECONCILE_MS);
  subagentReconcile.unref?.();

  // Background commands: their processes, output files and ends. Made with
  // the subagents, before the start-up wakes.
  const commands = createBackgroundCommandService({
    db: store.db,
    tasks: backgroundTasks,
    agentStore,
    sse,
    runner: deps.commandRunner ?? nodeShellCommandRunner,
    wake: (threadId, reason, triggerMessageId) => wakeScheduler.wake(threadId, reason, triggerMessageId),
    // A worker's turn can outlive its feature's archive: it starts nothing then.
    isRetired: (threadId) => retiredThreads.isThreadRetired(threadId),
    onTasksChanged: (parentThreadId) => monitorFeed.changed(parentThreadId)
  });

  managerSweeps = new ManagerSweeps({
    featuresStore,
    workStore,
    delayMs: deps.managerSweep?.delayMs,
    timers: deps.managerSweep?.timers,
    isOpenThread: (threadId) => {
      const thread = agentStore.getThreadById(threadId);
      return Boolean(thread && thread.scope === "manager" && !thread.archivedAt);
    },
    wakeScheduler: {
      wake: (threadId, reason, triggerMessageId) =>
        wakeScheduler.wake(threadId, reason, triggerMessageId),
      isThreadBusy: (threadId) => wakeScheduler.isThreadBusy(threadId),
      getRunningWakeForThread: (threadId) => wakeScheduler.getRunningWakeForThread(threadId)
    }
  });
  const unsubscribeWorkItemHeartbeat = [
    workStore.onChange((event) => managerSweeps?.notifyWorkerChanged(event.featureId)),
    featuresStore.onWorkItemChange((event) => managerSweeps?.notifyWorkerChanged(event.featureId)),
    broadcastWorkItemCreated({ workStore, featuresStore, sse })
  ];
  for (const threadId of agentStore.listThreadIdsWithQueuedMailboxMessages()) {
    // A subagent starts by its queue alone (just below), never by its mail.
    if (agentStore.getThreadById(threadId)?.scope === "subagent") continue;
    // Refused, the start goes on and the thread's follow-up wakes it for its mail.
    wakeScheduler.wakeForMail(threadId, startupMailboxWakeReason(agentStore.queuedMailboxSources(threadId)));
  }
  // The subagents the restart cut short (their wakes were ended above, and
  // none is resumed): each task ends interrupted and its parent is told, then
  // the queued ones start. After the wakes above, so a parent that was
  // mid-turn resumes as its recovery, under its own reason, and reads the
  // result at its next step.
  subagents.recoverAtStartup();
  // The commands the restart cut short: killed by their groups, each ended
  // interrupted, its conversation told and woken.
  commands.recoverAtStartup();
  // After those wakes have started: a thread recovering from the restart is
  // busy, so its waits stay open; so is a parent woken for its results.
  handoffs.cleanupAtStartup();

  const beforeThreadArchive = (threadId: string) => {
    extractWindow(threadId, "thread_archive", agentStore.getActiveMessages(threadId));
  };

  // Frees what a thread holds: open handoffs to it, its subagents (stopped,
  // and nobody told: the thread is going), queued user messages, watches,
  // monitors, alarms and a manager thread's sweep. Used when a manager
  // thread is archived.
  const releaseThreadResources = (threadId: string) => {
    handoffs.failOpenForThread(threadId, "the thread was archived");
    subagents.stopAllFor(threadId);
    commands.stopAllFor(threadId);
    userMessageQueue.clearThread(threadId);
    windowWatchManager.cancelThread(threadId);
    commandMonitorManager.cancelThread(threadId);
    alarmManager.cancelThread(threadId);
    managerSweeps?.disposeThread(threadId);
    managerStopCheck.forget(threadId);
  };

  return {
    wakeScheduler,
    compaction: {
      start: (threadId) => compressionController.compactNow(threadId),
      inFlight: (threadId) => compressionController.isCompacting(threadId)
    },
    userMessageQueue,
    onUserQueueChanged(listener) {
      queueChanged.add(listener);
      return () => { queueChanged.delete(listener); };
    },
    handoffs,
    managerStopCheck,
    subagents,
    commands,
    backgroundTasks,
    scopes,
    pendingMonitors: monitorFeed.snapshot,
    threadModels: createThreadModels({ config: () => config, agentStore, router: modelRouter, sse }),
    supportsInputForThread,
    threadActivity,
    allPendingMonitors: monitorFeed.all,
    cacheSealPauses: () => cacheSealer.pauses(),
    beforeThreadArchive,
    isThreadWorking: (threadId) =>
      turnRunning(threadId) || windowExtractor.inFlight(threadId)
      // A subagent or a command still queued or running writes into it: its result.
      || subagents.hasOpenTasks(threadId)
      // A manager stop check under way writes its call's row and its verdict.
      || managerStopCheck.judging(threadId),
    releaseThreadResources,
    beforeFeatureArchive,
    reloadConfig(nextConfig) {
      config = nextConfig;
      providers = createAgentRuntimeProviders(config);
      recorders = createAgentRuntimeLlmRecorders({ config, store });
      reloadAgentRuntimeMemoryManager(memoryManager, { config, store });
    },
    dispose() {
      stepsDisposed = true;
      // No seal goes out after the runtime is gone.
      cacheSealer.dispose();
      stopVoiceDrops();
      idleCompactor.dispose();
      for (const timer of stepRetries) clearTimeout(timer);
      stepRetries.clear();
      clearInterval(subagentReconcile);
      subagents.dispose();
      commands.dispose();
      managerSweeps?.dispose();
      for (const unsubscribe of unsubscribeWorkItemHeartbeat) unsubscribe();
      // All clear in-memory timers only; pending watch, monitor and alarm rows
      // stay in the database and are re-armed on the next start.
      windowWatchManager.dispose();
      commandMonitorManager.dispose();
      alarmManager.dispose();
      wakeScheduler.dispose();
    }
  };
}

/** A page subagent's start and end, as the page's publisher takes them. */
function pageRunHooks(publisher: Pick<PagePublisher, "afterSubagent" | "writeStarted">): PageRunHooks {
  return {
    started: (task) => publisher.writeStarted(task.id, task.title),
    ended: (task, end) => publisher.afterSubagent({ taskId: task.id, title: task.title, ...end })
  };
}
