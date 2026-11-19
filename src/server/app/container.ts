import path from "node:path";
import { WorkerRecordStore } from "../modules/plans/record-store.js";
import { PageStore } from "../modules/page/page-store.js";
import { prepareSite } from "../modules/page/page-site.js";
import { PAGE_CHANGE_BUILTINS, pageChangeDigest, PageUpdateManager } from "../modules/page/page-updates.js";
import { readBuiltin, type PageBuiltinDeps } from "../modules/page/page-builtins.js";
import { PagePublisher } from "../modules/page/page-publisher.js";
import { PageSourceManager } from "../modules/page/page-sources.js";
import { PageAnswers, PAGE_ANSWERS_LISTED } from "../modules/page/page-answers.js";
import { monitorRunnerFrom } from "../modules/agent/command-monitor-manager.js";
import { nodeShellCommandRunner } from "../platform/process/shell-command-runner.js";
import { PAGE_RUN_FAILURE } from "../../shared/page-run-failure.js";
import { personalAgentDir } from "../platform/fs/resources.js";
import fs from "node:fs";
import { Analyzer } from "../modules/analysis/analyzer.js";
import { AgentSseEmitter } from "../modules/sse/sse-events.js";
import { loadConfig, type Config } from "../config.js";
import { configPath, secureConfigFile } from "../config/config-store.js";
import { resolveDataDir } from "../platform/fs/data-dir.js";
import type { AppDeps } from "./deps.js";
import { buildAgentRuntime } from "../runtime/agent-runtime.js";
import { BroadcastCenter } from "../runtime/broadcast-center.js";
import { PlanStore } from "../modules/plans/plan-store.js";
import { publishTo } from "../runtime/events.js";
import { TmuxRuntime } from "../runtime/runtimes/tmux-runtime.js";
import { bootstrapSkills, resolveSkillsDirs } from "../runtime/skills-bootstrap.js";
import { TmuxPoller } from "../runtime/tmux-poller.js";
import { DEFAULT_TMUX } from "../platform/tmux/tmux.js";
import { DEFAULT_GIT } from "../platform/git/git.js";
import { logError } from "../platform/logger.js";
import { applyLoggingConfig } from "./logging-config.js";
import { reloadOrKeep } from "./config-reload.js";
import { createBackgroundJobsStarter } from "./background-jobs.js";
import { createAppStores } from "./stores.js";
import { createVoiceOrchestratorFactory } from "./voice.js";
import { closeInterruptedDreamRuns, MemoryDreamer } from "../modules/memory/dream.js";
import { MemoryDreamJob } from "../modules/memory/dream-job.js";
import { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import { normalizeLogRequests } from "../modules/activity/llm-call-logging.js";
import { createAgentProvider } from "../modules/agent/llm-provider.js";
import { buildProviderConfigs, runnableProviderConfigs } from "../runtime/agent-provider-config.js";
import { createAgentRuntimeMemoryManager, createUncountedMemoryManager, warmAgentMemoryVectors } from "../runtime/agent-memory.js";
import { BACKGROUND_TASKS_PAGE, SSE_EVENTS } from "../../shared/api-contracts.js";
import { ManagerThreadService, startManagerThreadBroadcast, threadDisplayTitle } from "../modules/agent/manager-threads.js";
import { ThreadLabels } from "../modules/agent/thread-labels.js";
import { ThreadArchive } from "../modules/agent/thread-archive.js";
import { WorkerService } from "../modules/workers/worker-service.js";
import { PersonalAgentService, startPersonalAgentBroadcast, publishQueueChange } from "../modules/personal/personal-agent-service.js";
import { createStatusHolder, startThreadStatusBroadcast } from "../modules/personal/thread-status-broadcast.js";
import { threadStatusSnapshot } from "../modules/personal/thread-status.js";
import { TaskBoardService } from "../modules/task-board/task-board-service.js";
import { StickyNotesService } from "../modules/sticky-notes/sticky-notes-service.js";
import { projectIdsOfThread, workRanIn } from "../modules/task-board/work-ran-in.js";
import { LearnedSkillStore } from "../modules/skills/learned-skill-store.js";
import { resolveReviewTarget } from "../modules/skills/review-target.js";
import { createSkillReviewJob, type SkillReviewJob } from "../modules/skills/skill-review-job.js";
import { createSkillTidy } from "../modules/skills/skill-tidy.js";
import { reviewLookupTools } from "../modules/skills/skill-review-tools.js";
import { createUnusedSkillsRule } from "../modules/skills/learned-skill-rule.js";
import { buildChatHistoryTools } from "../modules/agent/tools/chat-history.js";
import type { ReviewCandidate } from "../modules/skills/skill-review-run.js";
import { buildMemoryTools } from "../modules/memory/tools/memory.js";
import { learnedSkillRouteDeps } from "../modules/skills/skill-routes.js";
import { watchTaskThreads } from "../modules/task-board/thread-watch.js";
import { createTaskNotify, type TaskNotify } from "../modules/task-board/task-notify.js";
import { localTimeZone } from "../platform/time/agent-time.js";
import { displayPersonalAgentName } from "../../shared/personal-agent-name.js";
import type { ThreadDot } from "../../shared/thread-dot.js";
import { createKiloModelApisRefresher } from "../modules/llm/kilo-model-apis-refresh.js";
import { PriceData } from "../modules/pricing/price-data.js";
import { ActivityFill } from "../modules/activity/slice-fill.js";
import { PricingPass } from "../modules/pricing/pricing-pass.js";
import { globalHttpClient } from "../platform/http/http-client.js";
import { NotificationService } from "../modules/notifications/notification-service.js";
import { NotificationStore } from "../modules/notifications/notification-store.js";
import { PresenceBook } from "../modules/notifications/presence.js";
import { startNotificationWatch } from "../modules/notifications/safety-net.js";
import { listsMatter } from "../modules/notifications/waiting-match.js";
import type { WaitingEntryDto } from "../../shared/api/thread-status.js";
import { startBackgroundCheckpoints } from "../platform/db/checkpoint-away.js";
import { DEFAULT_SCHEDULE_CLOCK } from "../modules/schedules/schedule-manager.js";


interface AppContainer {
  config: Config;
  httpDeps(): AppDeps;
  startBackgroundJobs(): void;
  dispose(): Promise<void>;
}

export async function createAppContainer(): Promise<AppContainer> {
  const config = loadConfig();
  // It holds API keys: one written before (or by hand) others could read.
  secureConfigFile();
  applyLoggingConfig(config.logging);
  const {
    dbDir,
    store,
    projectsStore,
    workersStore,
    agentStore,
    canvasStore,
    workStore,
    paneMetadataStore
  } = createAppStores();
  // Dream runs the last process left in flight: nothing resumes them.
  closeInterruptedDreamRuns(store.db);

  const sse = new AgentSseEmitter();
  // Where the personal agent's notices go; its escalation ticker starts with the
  // background jobs.
  const notifications = new NotificationService({
    store: new NotificationStore(store.db),
    presence: new PresenceBook(),
    sse,
    getConfig: () => config,
    http: globalHttpClient,
    owners: (workerId) => workersStore.getById(workerId)?.ownerThreadId ?? null,
    listed: (matterKey) => listsMatter(waitingNow(), matterKey)
  });
  let stopNotifications: (() => void) | null = null;
  // What "Waiting on you" lists now: read once the status broadcast exists.
  let waitingNow: () => readonly WaitingEntryDto[] = () => [];
  const planStore = new PlanStore(store.db);
  const broadcaster = new BroadcastCenter({
    sse,
    projectsStore,
    workersStore,
    tmuxClient: DEFAULT_TMUX,
    getWorkerPlan: (workerId) => planStore.get(workerId)
  });
  const publishLifecycle = publishTo((event) => broadcaster.lifecycle(event));

  const skills = await bootstrapSkills(
    resolveSkillsDirs({
      builtinSkillsDir: path.resolve(import.meta.dirname, "..", "modules", "skills", "builtins"),
      dataDir: resolveDataDir(),
      extraDirs: config.skills.extraDirs
    })
  );
  // Learned skills: kept in the database, listed and loaded through the
  // registry beside the file skills (a file skill's name wins).
  const fileSkillNames = () => new Set(skills.registry.listAll().map((s) => s.name));
  const learnedSkills = new LearnedSkillStore(store.db, fileSkillNames);
  // A review or a tidy a stop cut short ends failed; the queued reviews wait
  // for the job, the tidy for when it is due again.
  learnedSkills.closeInterruptedReviews();
  learnedSkills.closeInterruptedTidies();
  // Made once the runtime is (its background tasks name a conversation's subagents).
  let skillReviewJob: SkillReviewJob | null = null;
  skills.registry.attachLearned({
    store: learnedSkills,
    projectName: (id) => projectsStore.getById(id)?.name ?? null,
    projectIdsOfThread: projectIdsOfThread({ workersStore }),
    projectIdByName: (name) => projectsStore.listActive().find((project) => project.name === name)?.id ?? null,
    notify: (request) => { void notifications.notify(request); },
    reviewTarget: (requesterThreadId, ref) => resolveReviewTarget({ agentStore, workersStore, store: learnedSkills }, requesterThreadId, ref),
    reviewRequested: () => skillReviewJob?.kick()
  });

  const analyzer = new Analyzer();
  const poller = new TmuxPoller({
    store,
    analyzer,
    broadcaster,
    tmuxClient: DEFAULT_TMUX,
    captureLines: config.captureLines,
    paneMetadata: paneMetadataStore
  });

  // A window whose geometry changed (a fit applied or released, a resize) is
  // polled at once rather than at the next poll interval.
  const tmuxRuntime = new TmuxRuntime({
    tmuxClient: DEFAULT_TMUX,
    projectsStore,
    workersStore,
    onWindowChanged: (windowId) => {
      void poller.poll({ forceWindowIds: [windowId] });
    }
  });

  await tmuxRuntime.init();

  // The one way a thread is archived, from its dialog and by the personal
  // agent. Made before the runtime, whose scopes are given it; what it needs
  // of the runtime and of the thread service it reads when it archives.
  const threadArchive: ThreadArchive = new ThreadArchive({
    agentStore,
    workerStore: workersStore,
    workers: new WorkerService({
      projects: projectsStore,
      workers: workersStore,
      tmuxClient: DEFAULT_TMUX,
      gitClient: DEFAULT_GIT,
      tmuxRuntime,
      agentStore,
      broadcast: publishLifecycle,
      beforeWorkerArchive: (workerId) => runtime.beforeWorkerArchive(workerId),
      refreshTmux: () => { void poller.poll({}); }
    }),
    wakes: {
      getRunningWakeForThread: (threadId) => runtime.wakeScheduler.getRunningWakeForThread(threadId),
      cancelWake: (wakeId) => runtime.wakeScheduler.cancelWake(wakeId)
    },
    releaseThreadResources: (threadId) => runtime.releaseThreadResources(threadId),
    beforeThreadArchive: (threadId) => runtime.beforeThreadArchive(threadId),
    broadcast: publishLifecycle,
    publishThread: (threadId) => managerThreads.publish(threadId)
  });
  // Personal agent's page: the folder it edits, its data sources (run in the
  // user's shell, from the personal agent's working directory), and what publishes
  // it when its writer ends.
  const pageStore = new PageStore(store.db);
  // A page subagent a restart cut short: its write failed. Its run ends
  // interrupted when the subagents recover, after which the next one starts.
  pageStore.markRunningWritesFailed(PAGE_RUN_FAILURE.interrupted);
  const pageDir = path.join(personalAgentDir(), "page");
  fs.mkdirSync(pageDir, { recursive: true });
  // A page folder that cannot be made ready leaves the page as it is, not Mandate stopped.
  try {
    prepareSite(pageDir);
  } catch (err) {
    logError("page: site/ could not be made ready in the page folder", err);
  }
  // A page subagent the page's own machinery starts (a scheduled update, a
  // look into a failing source): null while there is no personal agent.
  const startPageRun = (title: string, task: string) => {
    const thread = agentStore.openPersonalThread();
    return thread ? runtime.subagents.start({ parentThreadId: thread.id, title, task, type: "page" }).task.id : null;
  };
  const pageSources = new PageSourceManager({
    db: store.db,
    runner: monitorRunnerFrom(nodeShellCommandRunner),
    pageDir,
    defaultCwd: personalAgentDir(),
    store: pageStore,
    sse,
    startFix: startPageRun
  });
  // The page's scheduled updates: each a page subagent at its times, unless
  // nothing the page draws from, nor the personal agent's notes, changed.
  // Its runs start once the runtime is up (startBackgroundJobs).
  const pageUpdates = new PageUpdateManager({
    db: store.db,
    pageDir,
    store: pageStore,
    sse,
    timeZone: localTimeZone,
    startRun: startPageRun,
    runOpen: (taskId) => {
      const status = runtime.backgroundTasks.get(taskId)?.status;
      return status === "queued" || status === "running";
    },
    changeDigest: () => pageChangeDigest({
      data: async () => ({
        builtins: await Promise.all(PAGE_CHANGE_BUILTINS.map(async (name) => [name, await readBuiltin(name, pageBuiltins)])),
        sources: pageSources.list().map((source) => [source.name, pageSources.data(source.name)?.value ?? null])
      }),
      notesDir: path.join(personalAgentDir(), "notes")
    })
  });
  const pagePublisher = new PagePublisher({
    store: pageStore,
    agentStore,
    pageDir,
    personalThreadId: () => agentStore.openPersonalThread()?.id ?? null,
    applySources: () => pageSources.applyFile(),
    sourcesFile: () => pageSources.fileText(),
    applyUpdates: () => pageUpdates.applyFile(),
    updatesFile: () => pageUpdates.fileText(),
    scheduledEnded: (taskId, end) => pageUpdates.runEnded(taskId, end.status, end.error),
    sse
  });
  const pageAnswers = new PageAnswers({ store: pageStore, agentStore, sse });
  let resolveRuntimeReady!: () => void;
  const runtimeReady = new Promise<void>((resolve) => { resolveRuntimeReady = resolve; });
  // Built before the runtime, attached once the threads are: the runtime
  // pokes it.
  const threadStatus = createStatusHolder();
  // A schedule change republishes its thread's row. Bound once the thread
  // service exists: the schedules may change while the runtime is built.
  let publishDutyThread: ((threadId: string) => void) | null = null;
  // The owner's task board, built before the runtime: the personal agent's
  // tool writes through it.
  let taskDots: () => ReadonlyMap<string, ThreadDot> = () => new Map();
  // Its notifications: In review, and 09:00's due notice (started with the
  // background jobs).
  let taskNotify: TaskNotify | null = null;
  // Where threads' work ran: a task's automatic labels, a thread's projects.
  const ranIn = workRanIn({ workersStore, projectsStore });
  const threadProjects = (threadId: string) => ranIn([threadId]);
  const taskBoard = new TaskBoardService({
    db: store.db, agentStore, sse, threadDots: () => taskDots(),
    workRanIn: ranIn,
    threadLabelSpelling: (name) => agentStore.threadLabelSpelling(name),
    onStatusChanged: (task, from, by) => taskNotify?.onStatusChanged(task, from, by),
    onRemoved: (id) => taskNotify?.onRemoved(id),
    onOpened: (id) => taskNotify?.onOpened(id)
  });
  // The personal agent's sticky notes: before the runtime, which gives the agent its tool.
  // What a note is about is named as it is now; a thread or task gone since keeps the note's own copy.
  const stickyNotes = new StickyNotesService({
    db: store.db, sse,
    about: (ref) => {
      if (ref.kind === "thread") return agentStore.getThreadById(ref.id) ? threadDisplayTitle(agentStore, ref.id) : null;
      return taskBoard.detail(ref.id)?.title ?? null;
    }
  });
  // Threads and tasks share their labels' names: each asks the other for the
  // spelling already in use.
  const threadLabels = new ThreadLabels({
    agentStore,
    publish: (threadId) => { managerThreads.publish(threadId); },
    taskLabelSpelling: (name) => taskBoard.labelSpelling(name)
  });
  taskNotify = createTaskNotify({
    notifications, taskBoard, clock: DEFAULT_SCHEDULE_CLOCK, timeZone: localTimeZone,
    agentName: () => displayPersonalAgentName(config.agent.personalAgentName)
  });
  const runtime = buildAgentRuntime({
    taskBoard,
    stickyNotes,
    threadProjects,
    threadLabels,
    // Read once at start: an agent that rewrites config.json cannot undo it
    // before a restart.
    schedulesDisabled: !config.schedules.enabled,
    onScheduleChanged: (threadId) => publishDutyThread?.(threadId),
    status: threadStatus,
    notifications,
    // What the user has in front of them now is not told to the personal agent.
    ownerInThread: (threadId) => notifications.userInThread(threadId),
    config,
    ready: runtimeReady,
    store,
    projectsStore,
    workersStore,
    agentStore,
    workStore,
    canvasStore,
    sessionDataDir: dbDir,
    analyzer,
    sse,
    publishLifecycle,
    skillRegistry: skills.registry,
    getSnapshot: () => poller.getSnapshot(),
    tmuxClient: DEFAULT_TMUX,
    gitClient: DEFAULT_GIT,
    tmuxRuntime,
    paneMetadata: paneMetadataStore,
    threadArchive,
    page: { dir: pageDir, publisher: pagePublisher, answers: pageAnswers }
  });

  const managerThreads = new ManagerThreadService({
    agentStore,
    sse,
    isRunning: (threadId) => Boolean(runtime.wakeScheduler.getRunningWakeForThread(threadId)),
    dutySummary: runtime.dutySummary,
    projects: threadProjects
  });
  publishDutyThread = (threadId) => { managerThreads.publish(threadId); };
  const stopManagerThreadBroadcast = startManagerThreadBroadcast({ sse, service: managerThreads, agentStore, workers: workersStore });
  const personalAgent = new PersonalAgentService({
    agentStore,
    handoffs: runtime.handoffs,
    config,
    heldBack: runtime.threadActivity.heldBack,
    emit: (agent) => sse.emit(SSE_EVENTS.personalAgentUpdated, { agent })
  });
  const stopPersonalAgentBroadcast = startPersonalAgentBroadcast({ sse, service: personalAgent, agentStore });
  const statusBroadcast = startThreadStatusBroadcast({
    sse,
    scopeOf: (threadId) => agentStore.getThreadById(threadId)?.scope ?? null,
    compute: () => threadStatusSnapshot({
      agentStore, workersStore, projectsStore, workStore, planStore, managerThreads,
      isBusy: runtime.threadActivity.isBusy,
      waitKind: runtime.threadActivity.waitKind,
      heldBack: runtime.threadActivity.heldBack,
      verdictOf: (threadId) => runtime.managerStopCheck.current(threadId),
      agentQuestions: () => {
        const personal = agentStore.openPersonalThread();
        return personal ? agentStore.openQuestions(personal.id).map((q) => q.question) : [];
      },
      agentHeldBack: () => {
        const personal = agentStore.openPersonalThread();
        const held = personal ? runtime.threadActivity.heldBack(personal.id) : null;
        return personal && held ? { threadId: personal.id, held } : null;
      }
    })
  });
  threadStatus.attach(statusBroadcast);
  // The board's threads' dots are the status broadcast's, bound once it exists.
  taskDots = () => new Map(statusBroadcast.current().threads.map((t) => [t.threadId, t.state] as const));
  // A linked thread's turn ended, its dot moved or a worker left or joined
  // it: its tasks are sent again.
  const stopTaskThreadWatch = watchTaskThreads(sse, taskBoard, workersStore);
  waitingNow = () => statusBroadcast.current().waiting;
  // The system's own notices when the personal agent is stuck, and matters settling.
  const stopNotificationWatch = startNotificationWatch({
    sse, service: notifications, agentStore, getConfig: () => config, current: () => statusBroadcast.current()
  });
  // An answer taken in behind a running turn closes its question at once:
  // the conversation's state is published then, not when the message lands.
  const stopQueueBroadcast = runtime.onUserQueueChanged(publishQueueChange({ managerThreads, agentStore, personalAgent, status: statusBroadcast }));

  let memoryDreamJob = buildMemoryDreamJob(config, {
    store,
    agentStore,
    projectsStore,
    workersStore
  });
  // Memory as the reviews and the tidy read it: every project's, reading only.
  const reviewMemoryTools = () => buildMemoryTools({
    memory: createUncountedMemoryManager({ config, store }),
    scope: "manager",
    records: new WorkerRecordStore(store.db),
    agentStore,
    projectsStore
  });
  const skillReviewCandidates = () => recordedCandidates(config, store, runnableProviderConfigs(config, "skillReview").map(createAgentProvider));
  const skillTidy = createSkillTidy({
    store: learnedSkills,
    candidates: skillReviewCandidates,
    // Memory only: the tidy reads no conversation.
    lookupTools: () => reviewLookupTools({ memoryTools: reviewMemoryTools(), historyTools: [] }),
    projects: () => projectsStore.listActive().map((p) => ({ id: p.id, name: p.name })),
    projectName: (id) => projectsStore.getById(id)?.name ?? null,
    notify: (request) => { void notifications.notify(request); }
  });
  skillReviewJob = createSkillReviewJob({
    store: learnedSkills,
    agentStore,
    workersStore,
    projectsStore,
    backgroundTasks: runtime.backgroundTasks,
    projectIdsOfThread: projectIdsOfThread({ workersStore }),
    fileSkillNames,
    // Read at each run, so a reloaded config's models and embedder are used.
    lookupTools: () => reviewLookupTools({
      memoryTools: reviewMemoryTools(),
      historyTools: buildChatHistoryTools({ db: store.db, scope: "manager" })
    }),
    candidates: skillReviewCandidates,
    notify: (request) => { void notifications.notify(request); },
    tidy: { due: () => learnedSkills.tidyDue(), run: () => skillTidy.run() }
  });

  // Prices: the copies saved by earlier downloads; none ship with Mandate.
  const priceData = new PriceData({ dataDir: resolveDataDir(), http: globalHttpClient, autoUpdate: () => config.models.prices.autoUpdate });
  void priceData.load().catch((e) => logError("price-data", e, "the saved price data could not be read; it is downloaded again when needed"));

  // Kilo's per-model API tags: the saved copy, then each Kilo connection's
  // own list, at start (with the background jobs) and once a day. A changed
  // tag reloads the config, so later steps build the model on its new API.
  const kiloModelApis = createKiloModelApisRefresher({
    dataDir: resolveDataDir(),
    http: globalHttpClient,
    providers: () => config.models.providers,
    onChange: () => reloadRuntimeConfig()
  });

  const pricingPass = new PricingPass({ db: store.db, data: priceData, providers: () => config.models.providers });
  const backgroundJobs = createBackgroundJobsStarter({
    config,
    poller,
    onInitialPollComplete: resolveRuntimeReady,
    memoryDreamJob: () => memoryDreamJob,
    skillReviewJob,
    unusedSkillsRule: createUnusedSkillsRule({ store: learnedSkills, notify: (request) => notifications.notify(request) }),
    directChats: runtime.directChats,
    db: store.db,
    priceData,
    pricingPass,
    activityFill: new ActivityFill({
      db: store.db,
      catalog: () => priceData.catalog(),
      providers: () => config.models.providers,
      pricingIdle: () => pricingPass.idle()
    }),
    checkpoints: (db) => startBackgroundCheckpoints(db, { intervalMs: config.runtime.checkpointEveryMs }),
    memoryVectors: { warm: () => warmAgentMemoryVectors({ config, store }) }
  });

  const buildVoiceOrchestrator = createVoiceOrchestratorFactory({
    config,
    runtime,
    skills,
    agentStore,
    sse,
    waiting: () => statusBroadcast.current().waiting,
    pagePublisher,
    activeProjectIds: () => projectsStore.listActive().map((project) => project.id)
  });

  const reloadRuntimeConfig = () => {
    // A file the server would refuse leaves the running config as it is.
    const next = reloadOrKeep(() => loadConfig(), (error) => {
      console.error(`[mandate] config not reloaded, the running one kept: ${error.message}`);
    });
    if (!next) return config;
    replaceConfigInPlace(config, next);
    applyLoggingConfig(config.logging);
    poller.updateConfig({ captureLines: config.captureLines });
    runtime.reloadConfig(config);
    memoryDreamJob = buildMemoryDreamJob(config, {
      store,
      agentStore,
      projectsStore,
      workersStore
    });
    backgroundJobs.refreshPollInterval();
    // A rename reaches every tab.
    personalAgent.publish();
    // The manager stop check switched off (or on) shows at once, its blue gone.
    statusBroadcast.poke();
    return config;
  };

  // What the page's built-in sources read: its routes, and what a
  // scheduled update compares to tell whether anything changed.
  const pageBuiltins: PageBuiltinDeps = {
    db: store.db,
    agentStore,
    managerThreads,
    canvasStore,
    workersStore,
    projectsStore,
    workStore,
    planStore,
    isBusy: runtime.threadActivity.isBusy,
    waitKind: runtime.threadActivity.waitKind,
    heldBack: runtime.threadActivity.heldBack,
    statusSnapshot: () => statusBroadcast.current(),
    answers: () => pageAnswers.list(PAGE_ANSWERS_LISTED),
    schedules: { store: runtime.scheduleStore, now: DEFAULT_SCHEDULE_CLOCK.now },
    tasks: () => taskBoard.list()
  };

  return {
    config,
    httpDeps() {
      return {
        sse,
        getSnapshot: () => poller.getSnapshot(),
        getSnapshotError: () => poller.getLastError(),
        getProjectsState: () => broadcaster.getProjectsStateSnapshot(),
        getProjectsStateNow: () => broadcaster.projectsStateNow(),
        getWorkerPlans: () => planStore.pagePlansOfActive(),
        managerThreads,
        getManagerThreads: () => managerThreads.list(),
        getThreadStatus: () => statusBroadcast.current(),
        personalAgent,
        getPersonalAgent: () => personalAgent.state(),
        notifications,
        pageStore,
        pageSources,
        pageUpdates,
        pageAnswers,
        pageBuiltins,
        schedules: runtime.schedules,
        sideChats: runtime.sideChats,
        getSideChats: () => runtime.sideChats.list(),
        taskBoard,
        threadLabels,
        threadProjects,
        getTaskBoard: () => taskBoard.list(),
        stickyNotes,
        getStickyNotes: () => stickyNotes.list(),
        calendar: runtime.calendar,
        dutyReportsFor: (ids) => runtime.scheduleStore.reportsFor(ids),
        heartbeatMs: config.runtime.sseHeartbeatMs,
        priceData,
        projects: projectsStore,
        workers: workersStore,
        canvasStore,
        sessionDataDir: dbDir,
        tmuxClient: DEFAULT_TMUX,
        gitClient: DEFAULT_GIT,
        agentStore,
        workStore,
        wakeScheduler: runtime.wakeScheduler,
        compaction: runtime.compaction,
        isThreadWorking: runtime.isThreadWorking,
        cacheSealPauses: runtime.cacheSealPauses,
        threadArchive,
        backgroundTasks: {
          get: (taskId) => runtime.backgroundTasks.get(taskId),
          detailOf: (taskId) => {
            const brief = runtime.backgroundTasks.taskText(taskId);
            return brief === null ? null : { brief, reply: runtime.backgroundTasks.replyOf(taskId) };
          },
          pageForThread: (threadId, before) => runtime.backgroundTasks.pageForThread(threadId, { before, limit: BACKGROUND_TASKS_PAGE }),
          changedSince: (threadId, since) => runtime.backgroundTasks.changedSince(threadId, since),
          // Each kind by its own service.
          stop: (taskId) => (runtime.backgroundTasks.get(taskId)?.kind === "command" ? runtime.commands.stop(taskId, "user") : runtime.subagents.stop(taskId, "user")),
          commandOutput: (taskId) => {
            const task = runtime.backgroundTasks.get(taskId);
            const tail = task?.kind === "command" ? runtime.commands.tail(taskId) : null;
            return task && tail ? { ...tail, path: task.outputPath ?? "" } : null;
          }
        },
        pendingMonitors: runtime.pendingMonitors,
        threadModels: runtime.threadModels,
        supportsInputForThread: runtime.supportsInputForThread,
        allPendingMonitors: runtime.allPendingMonitors,
        beforeWorkerArchive: runtime.beforeWorkerArchive,
        userMessageQueue: runtime.userMessageQueue,
        scopes: runtime.scopes,
        broadcast: publishLifecycle,
        poller,
        store,
        config,
        configFileExists: () => fs.existsSync(configPath()),
        reloadConfig: reloadRuntimeConfig,
        kiloModelApis,
        pollTmux: (opts) => poller.poll(opts),
        tmuxRuntime,
        paneMetadata: paneMetadataStore,
        skills: { list: skills.list, refresh: skills.refresh },
        learnedSkills: learnedSkillRouteDeps({ store: learnedSkills, projectsStore, agentStore, workersStore }),
        buildVoiceOrchestrator,
        memoryDreamJob: () => memoryDreamJob
      };
    },
    startBackgroundJobs: () => {
      backgroundJobs.start();
      pageUpdates.start();
      stopNotifications ??= notifications.start();
      taskNotify?.start();
      void kiloModelApis.load().then(() => kiloModelApis.start());
    },
    async dispose() {
      backgroundJobs.stop();
      stopNotifications?.();
      taskNotify?.stop();
      stopNotificationWatch();
      kiloModelApis.dispose();
      pageSources.dispose();
      pageUpdates.dispose();
      stopManagerThreadBroadcast();
      stopPersonalAgentBroadcast();
      stopTaskThreadWatch();
      statusBroadcast.stop();
      stopQueueBroadcast();
      runtime.dispose();
      await Promise.race([
        tmuxRuntime.dispose(),
        new Promise((resolve) => setTimeout(resolve, 500))
      ]);
    }
  };
}

/** The dream's models in order: its own route, else the default's. */
export function memoryDreamProviderConfigs(config: Config) {
  return buildProviderConfigs(config, "dream");
}

/** A route's models in order, each with a recorder of its calls: the
 *  dream's and the skill review's. */
function recordedCandidates(config: Config, store: ReturnType<typeof createAppStores>["store"], providers: ReturnType<typeof createAgentProvider>[]): ReviewCandidate[] {
  const logRequests = normalizeLogRequests(config.agent.logRequests);
  return providers.map((candidate) => ({
    model: candidate.model,
    provider: candidate.meta.provider,
    modelName: candidate.meta.model,
    reasoningEffort: candidate.meta.reasoningEffort,
    supportsReasoning: candidate.meta.supportsReasoning,
    recorder: new AgentLlmCallRecorder({
      store,
      logRequests,
      provider: candidate.meta.provider,
      providerName: candidate.meta.providerName,
      api: candidate.meta.api,
      providerType: candidate.meta.providerType,
      model: candidate.meta.model,
      baseURL: candidate.meta.baseURL || "",
      apiMode: "streamText"
    })
  }));
}

function buildMemoryDreamJob(
  config: Config,
  input: {
    store: ReturnType<typeof createAppStores>["store"];
    agentStore: ReturnType<typeof createAppStores>["agentStore"];
    projectsStore: ReturnType<typeof createAppStores>["projectsStore"];
    workersStore: ReturnType<typeof createAppStores>["workersStore"];
  }
): MemoryDreamJob | null {
  const memoryDreamProviders = config.memory.dream.enabled
    ? memoryDreamProviderConfigs(config).map(createAgentProvider)
    : null;
  if (!memoryDreamProviders?.length) return null;
  const candidates = recordedCandidates(config, input.store, memoryDreamProviders);

  const memoryDreamer = new MemoryDreamer({
    db: input.store.db,
    records: new WorkerRecordStore(input.store.db),
    memory: createAgentRuntimeMemoryManager({ config, store: input.store }),
    agentStore: input.agentStore,
    projectsStore: input.projectsStore,
    workersStore: input.workersStore,
    candidates,
    contextLimitTokens: config.agent.compressionThresholdTokens
  });
  return new MemoryDreamJob({
    db: input.store.db,
    dreamer: memoryDreamer,
    activeProjectIds: () => input.projectsStore.listActive().map((p) => p.id),
    partitionIntervalMs: 6 * 60 * 60 * 1000
  });
}

function replaceConfigInPlace(target: Config, source: Config): void {
  for (const key of Object.keys(target) as Array<keyof Config>) {
    delete target[key];
  }
  Object.assign(target, source);
}
