import path from "node:path";
import { FeatureRecordStore } from "../modules/plans/record-store.js";
import { PageStore } from "../modules/page/page-store.js";
import { PagePublisher } from "../modules/page/page-publisher.js";
import { PageSourceManager } from "../modules/page/page-sources.js";
import { PageAnswers, PAGE_ANSWERS_LISTED } from "../modules/page/page-answers.js";
import { monitorRunnerFrom } from "../modules/agent/command-monitor-manager.js";
import { nodeShellCommandRunner } from "../platform/process/shell-command-runner.js";
import { PAGE_RUN_FAILURE } from "../../shared/page-run-failure.js";
import { globalAgentDir } from "../platform/fs/resources.js";
import fs from "node:fs";
import { Analyzer } from "../modules/analysis/analyzer.js";
import { AgentSseEmitter } from "../modules/sse/sse-events.js";
import { loadConfig, type Config } from "../config.js";
import { configPath } from "../config/config-store.js";
import { resolveDataDir } from "../platform/fs/data-dir.js";
import type { AppDeps } from "./deps.js";
import { computeProjectsState } from "../modules/projects/projects-state.js";
import { buildAgentRuntime } from "../runtime/agent-runtime.js";
import { BroadcastCenter } from "../runtime/broadcast-center.js";
import { PlanStore } from "../modules/plans/plan-store.js";
import { AppEventBus, type LifecyclePublisher } from "../runtime/events.js";
import { buildPaneRuntimes, type PaneRuntimeRegistry } from "../runtime/pane-runtime-registry.js";
import { bootstrapSkills, resolveSkillsDirs } from "../runtime/skills-bootstrap.js";
import { TmuxPoller } from "../runtime/tmux-poller.js";
import { DEFAULT_TMUX, tmuxListSessionsWithWindows } from "../platform/tmux/tmux.js";
import { DEFAULT_GIT } from "../platform/git/git.js";
import { setLogLevel, logError } from "../platform/logger.js";
import { createBackgroundJobsStarter } from "./background-jobs.js";
import { createAppStores } from "./stores.js";
import { createVoiceOrchestratorFactory } from "./voice.js";
import { closeInterruptedDreamRuns, MemoryDreamer } from "../modules/memory/dream.js";
import { MemoryDreamJob } from "../modules/memory/dream-job.js";
import { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import { normalizeLogRequests } from "../modules/activity/llm-call-logging.js";
import { createAgentProvider } from "../modules/agent/llm-provider.js";
import { buildProviderConfig, buildProviderConfigs } from "../runtime/agent-provider-config.js";
import { createAgentRuntimeMemoryManager } from "../runtime/agent-memory.js";
import { BACKGROUND_TASKS_PAGE, DEFAULT_SSE_HEARTBEAT_MS, SSE_EVENTS } from "../../shared/api-contracts.js";
import { ManagerThreadService, startManagerThreadBroadcast } from "../modules/agent/manager-threads.js";
import { ThreadArchive } from "../modules/agent/thread-archive.js";
import { FeatureService } from "../modules/features/feature-service.js";
import { GlobalAgentService, startGlobalAgentBroadcast } from "../modules/global/global-agent-service.js";
import { createStatusHolder, startThreadStatusBroadcast } from "../modules/global/thread-status-broadcast.js";
import { threadStatusSnapshot } from "../modules/global/thread-status.js";
import { createKiloModelApisRefresher } from "../modules/llm/kilo-model-apis-refresh.js";
import { PriceData } from "../modules/pricing/price-data.js";
import { PricingPass } from "../modules/pricing/pricing-pass.js";
import { globalHttpClient } from "../platform/http/http-client.js";

const SSE_HEARTBEAT_MS = Number(process.env.MANDATE_SSE_HEARTBEAT_MS ?? DEFAULT_SSE_HEARTBEAT_MS);

interface AppContainer {
  config: Config;
  analyzer: Analyzer;
  paneRuntimes: PaneRuntimeRegistry;
  httpDeps(): AppDeps;
  startBackgroundJobs(): void;
  dispose(): Promise<void>;
}

export async function createAppContainer(): Promise<AppContainer> {
  const config = loadConfig();
  setLogLevel(config.logging.level);
  const {
    dbDir,
    store,
    projectsStore,
    featuresStore,
    agentStore,
    canvasStore,
    workStore,
    paneMetadataStore
  } = createAppStores();
  // Dream runs the last process left in flight: nothing resumes them.
  closeInterruptedDreamRuns(store.db);

  const sse = new AgentSseEmitter();
  const events = new AppEventBus();
  const planStore = new PlanStore(store.db);
  const broadcaster = new BroadcastCenter({
    sse,
    projectsStore,
    featuresStore,
    tmuxClient: DEFAULT_TMUX,
    getFeaturePlan: (featureId) => planStore.get(featureId)
  });
  const publishLifecycle: LifecyclePublisher = (event) => {
    events.emit({ type: "lifecycle", event });
  };
  events.on("lifecycle", ({ event }) => broadcaster.lifecycle(event));

  const skills = await bootstrapSkills(
    resolveSkillsDirs({
      builtinSkillsDir: path.resolve(import.meta.dirname, "..", "modules", "skills", "builtins"),
      dataDir: resolveDataDir(),
      extraSkillsDirsEnv: process.env.MANDATE_SKILLS_DIR
    })
  );

  const analyzer = new Analyzer();
  const poller = new TmuxPoller({
    store,
    analyzer,
    broadcaster,
    tmuxClient: DEFAULT_TMUX,
    captureLines: config.captureLines,
    paneMetadata: paneMetadataStore
  });

  const paneRuntimes = buildPaneRuntimes({
    tmuxClient: DEFAULT_TMUX,
    projectsStore,
    featuresStore,
    onWindowChanged: (windowId) => {
      void poller.poll({ forceWindowIds: [windowId] });
    }
  });
  broadcaster.attachAnalyzer(analyzer);

  await paneRuntimes.tmux.init();

  // The one way a thread is archived, from its dialog and by the global
  // agent. Made before the runtime, whose scopes are given it; what it needs
  // of the runtime and of the thread service it reads when it archives.
  const threadArchive: ThreadArchive = new ThreadArchive({
    agentStore,
    features: featuresStore,
    workers: new FeatureService({
      projects: projectsStore,
      features: featuresStore,
      tmuxClient: DEFAULT_TMUX,
      gitClient: DEFAULT_GIT,
      paneRuntimes,
      agentStore,
      broadcast: publishLifecycle,
      beforeFeatureArchive: (featureId) => runtime.beforeFeatureArchive(featureId),
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
  // Your agent's page: the folder it edits, its data sources (run in the
  // user's shell, from Your agent's working directory), and what publishes
  // it when its writer ends.
  const pageStore = new PageStore(store.db);
  // A page subagent a restart cut short: its write failed. Its run ends
  // interrupted when the subagents recover, after which the next one starts.
  pageStore.markRunningWritesFailed(PAGE_RUN_FAILURE.interrupted);
  const pageDir = path.join(globalAgentDir(), "page");
  fs.mkdirSync(pageDir, { recursive: true });
  const pageSources = new PageSourceManager({
    db: store.db,
    runner: monitorRunnerFrom(nodeShellCommandRunner),
    pageDir,
    defaultCwd: globalAgentDir(),
    store: pageStore,
    sse
  });
  const pagePublisher = new PagePublisher({
    store: pageStore,
    agentStore,
    pageDir,
    globalThreadId: () => agentStore.openGlobalThread()?.id ?? null,
    applySources: () => pageSources.applyFile(),
    sourcesFile: () => pageSources.fileText(),
    sse
  });
  const pageAnswers = new PageAnswers({ store: pageStore, agentStore, sse });
  let resolveRuntimeReady!: () => void;
  const runtimeReady = new Promise<void>((resolve) => { resolveRuntimeReady = resolve; });
  // Built before the runtime, attached once the threads are: the runtime
  // pokes it.
  const threadStatus = createStatusHolder();
  const runtime = buildAgentRuntime({
    status: threadStatus,
    config,
    ready: runtimeReady,
    store,
    projectsStore,
    featuresStore,
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
    paneRuntimes,
    paneMetadata: paneMetadataStore,
    threadArchive,
    page: { dir: pageDir, publisher: pagePublisher, answers: pageAnswers }
  });

  const managerThreads = new ManagerThreadService({
    agentStore,
    sse,
    isRunning: (threadId) => Boolean(runtime.wakeScheduler.getRunningWakeForThread(threadId))
  });
  const stopManagerThreadBroadcast = startManagerThreadBroadcast({ sse, service: managerThreads, agentStore });
  const globalAgent = new GlobalAgentService({
    agentStore,
    handoffs: runtime.handoffs,
    config,
    emit: (agent) => sse.emit(SSE_EVENTS.globalAgentUpdated, { agent })
  });
  const stopGlobalAgentBroadcast = startGlobalAgentBroadcast({ sse, service: globalAgent, agentStore });
  const statusBroadcast = startThreadStatusBroadcast({
    sse,
    scopeOf: (threadId) => agentStore.getThreadById(threadId)?.scope ?? null,
    compute: () => threadStatusSnapshot({
      agentStore, featuresStore, projectsStore, workStore, planStore, managerThreads,
      isBusy: runtime.threadActivity.isBusy,
      waitKind: runtime.threadActivity.waitKind,
      verdictOf: (threadId) => runtime.managerStopCheck.current(threadId),
      agentQuestions: () => {
        const global = agentStore.openGlobalThread();
        return global ? agentStore.openQuestions(global.id).map((q) => q.question) : [];
      }
    })
  });
  threadStatus.attach(statusBroadcast);
  // An answer taken in behind a running turn closes its question at once:
  // the conversation's state is published then, not when the message lands.
  const stopQueueBroadcast = runtime.onUserQueueChanged((threadId) => {
    if (!managerThreads.publish(threadId) && agentStore.getThreadById(threadId)?.scope === "global") globalAgent.publish();
  });

  let memoryDreamJob = buildMemoryDreamJob(config, {
    store,
    agentStore,
    projectsStore,
    featuresStore
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

  const backgroundJobs = createBackgroundJobsStarter({
    config,
    poller,
    onInitialPollComplete: resolveRuntimeReady,
    memoryDreamJob: () => memoryDreamJob,
    db: store.db,
    priceData,
    pricingPass: new PricingPass({ db: store.db, data: priceData, providers: () => config.models.providers })
  });

  const buildVoiceOrchestrator = createVoiceOrchestratorFactory({
    config,
    runtime,
    skills,
    agentStore,
    sse,
    waiting: () => statusBroadcast.current().waiting,
    pagePublisher
  });

  const reloadRuntimeConfig = () => {
    const next = loadConfig();
    replaceConfigInPlace(config, next);
    setLogLevel(config.logging.level);
    poller.updateConfig({ captureLines: config.captureLines });
    runtime.reloadConfig(config);
    memoryDreamJob = buildMemoryDreamJob(config, {
      store,
      agentStore,
      projectsStore,
      featuresStore
    });
    backgroundJobs.refreshPollInterval();
    // A rename reaches every tab.
    globalAgent.publish();
    // The manager stop check switched off (or on) shows at once, its blue gone.
    statusBroadcast.poke();
    return config;
  };

  return {
    config,
    analyzer,
    paneRuntimes,
    httpDeps() {
      return {
        sse,
        getSnapshot: () => poller.getSnapshot(),
        getSnapshotError: () => poller.getLastError(),
        getProjectsState: () => broadcaster.getProjectsStateSnapshot(),
        getFeaturePlans: () => planStore.listActive(),
        managerThreads,
        getManagerThreads: () => managerThreads.list(),
        getThreadStatus: () => statusBroadcast.current(),
        globalAgent,
        getGlobalAgent: () => globalAgent.state(),
        pageStore,
        pageSources,
        pageAnswers,
        pageBuiltins: {
          db: store.db,
          agentStore,
          managerThreads,
          canvasStore,
          featuresStore,
          projectsStore,
          workStore,
          planStore,
          isBusy: runtime.threadActivity.isBusy,
          waitKind: runtime.threadActivity.waitKind,
          statusSnapshot: () => statusBroadcast.current(),
          answers: () => pageAnswers.list(PAGE_ANSWERS_LISTED)
        },
        heartbeatMs: SSE_HEARTBEAT_MS,
        priceData,
        projects: projectsStore,
        features: featuresStore,
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
        beforeFeatureArchive: runtime.beforeFeatureArchive,
        userMessageQueue: runtime.userMessageQueue,
        scopes: runtime.scopes,
        broadcast: publishLifecycle,
        poller,
        store,
        analyzer,
        config,
        configFileExists: () => fs.existsSync(configPath()),
        reloadConfig: reloadRuntimeConfig,
        kiloModelApis,
        pollTmux: (opts) => poller.poll(opts),
        computeProjectsState,
        tmuxListSessionsWithWindows,
        paneRuntimes,
        paneMetadata: paneMetadataStore,
        skills: { list: skills.list, refresh: skills.refresh },
        buildVoiceOrchestrator,
        memoryDreamJob: () => memoryDreamJob
      };
    },
    startBackgroundJobs: () => {
      backgroundJobs.start();
      void kiloModelApis.load().then(() => kiloModelApis.start());
    },
    async dispose() {
      backgroundJobs.stop();
      kiloModelApis.dispose();
      pageSources.dispose();
      stopManagerThreadBroadcast();
      stopGlobalAgentBroadcast();
      statusBroadcast.stop();
      stopQueueBroadcast();
      runtime.dispose();
      await Promise.race([
        paneRuntimes.tmux.dispose(),
        new Promise((resolve) => setTimeout(resolve, 500))
      ]);
    }
  };
}

/** The dream's models in order: its own route, else the default's. */
export function memoryDreamProviderConfigs(config: Config) {
  return buildProviderConfigs(config, "dream");
}

function buildMemoryDreamJob(
  config: Config,
  input: {
    store: ReturnType<typeof createAppStores>["store"];
    agentStore: ReturnType<typeof createAppStores>["agentStore"];
    projectsStore: ReturnType<typeof createAppStores>["projectsStore"];
    featuresStore: ReturnType<typeof createAppStores>["featuresStore"];
  }
): MemoryDreamJob | null {
  const memoryDreamProviders = config.memory.dream.enabled
    ? memoryDreamProviderConfigs(config).map(createAgentProvider)
    : null;
  if (!memoryDreamProviders?.length) return null;
  const memoryDreamProvider =
    memoryDreamProviders[0] ?? createAgentProvider(buildProviderConfig(config, "dream"));
  const logRequests = normalizeLogRequests(config.agent.logRequests);
  const candidates = memoryDreamProviders.map((candidate) => ({
    model: candidate.model,
    provider: candidate.meta.provider,
    modelName: candidate.meta.model,
    reasoningEffort: candidate.meta.reasoningEffort,
    supportsReasoning: candidate.meta.supportsReasoning,
    recorder: new AgentLlmCallRecorder({
      store: input.store,
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

  const memoryDreamer = new MemoryDreamer({
    db: input.store.db,
    records: new FeatureRecordStore(input.store.db),
    memory: createAgentRuntimeMemoryManager({ config, store: input.store }),
    agentStore: input.agentStore,
    projectsStore: input.projectsStore,
    featuresStore: input.featuresStore,
    model: memoryDreamProvider.model,
    provider: memoryDreamProvider.meta.provider,
    modelName: memoryDreamProvider.meta.model,
    reasoningEffort: memoryDreamProvider.meta.reasoningEffort,
    supportsReasoning: memoryDreamProvider.meta.supportsReasoning,
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
