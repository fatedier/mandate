import path from "node:path";
import fs from "node:fs";
import { Analyzer } from "../modules/analysis/analyzer.js";
import { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import { normalizeLogRequests } from "../modules/activity/llm-call-logging.js";
import { AgentSseEmitter } from "../modules/sse/sse-events.js";
import { loadConfig, type Config } from "../config.js";
import { configPath } from "../config/config-store.js";
import { resolveDataDir } from "../platform/fs/data-dir.js";
import type { AppDeps } from "./deps.js";
import { computeProjectsState } from "../modules/projects/projects-state.js";
import { buildAgentRuntime } from "../runtime/agent-runtime.js";
import { BroadcastCenter } from "../runtime/broadcast-center.js";
import { AppEventBus, type LifecyclePublisher } from "../runtime/events.js";
import { buildPaneRuntimes, type PaneRuntimeRegistry } from "../runtime/pane-runtime-registry.js";
import { bootstrapSkills, resolveSkillsDirs } from "../runtime/skills-bootstrap.js";
import { TmuxPoller } from "../runtime/tmux-poller.js";
import { DEFAULT_TMUX, tmuxListSessionsWithWindows } from "../platform/tmux/tmux.js";
import { DEFAULT_GIT } from "../platform/git/git.js";
import { setLogLevel } from "../platform/logger.js";
import { UiContextRegistry } from "../modules/ui-context/ui-context-registry.js";
import { createBackgroundJobsStarter } from "./background-jobs.js";
import { createAppStores } from "./stores.js";
import { createVoiceOrchestratorFactory } from "./voice.js";
import { MemoryDreamer, MemoryDreamJob } from "../modules/memory/dream.js";
import { createAgentProvider } from "../modules/agent/llm-provider.js";
import { buildProviderConfig, buildProviderConfigs } from "../runtime/agent-provider-config.js";
import { createAgentRuntimeMemoryManager } from "../runtime/agent-memory.js";
import { DEFAULT_SSE_HEARTBEAT_MS } from "../../shared/api-contracts.js";

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

  const sse = new AgentSseEmitter();
  const uiContextRegistry = new UiContextRegistry((event, data) => sse.emit(event, data));
  const events = new AppEventBus();
  const broadcaster = new BroadcastCenter({
    sse,
    projectsStore,
    featuresStore,
    tmuxClient: DEFAULT_TMUX
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

  let resolveRuntimeReady!: () => void;
  const runtimeReady = new Promise<void>((resolve) => { resolveRuntimeReady = resolve; });
  const runtime = buildAgentRuntime({
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
    uiContextRegistry
  });

  let memoryDreamJob = buildMemoryDreamJob(config, {
    store,
    agentStore
  });

  const backgroundJobs = createBackgroundJobsStarter({
    config,
    poller,
    onInitialPollComplete: resolveRuntimeReady,
    memoryDreamJob: () => memoryDreamJob,
    db: store.db
  });

  const buildVoiceOrchestrator = createVoiceOrchestratorFactory({
    config,
    runtime,
    skills,
    agentStore,
    sse,
    uiContextRegistry
  });

  const reloadRuntimeConfig = () => {
    const next = loadConfig();
    replaceConfigInPlace(config, next);
    setLogLevel(config.logging.level);
    poller.updateConfig({ captureLines: config.captureLines });
    runtime.reloadConfig(config);
    memoryDreamJob = buildMemoryDreamJob(config, {
      store,
      agentStore
    });
    backgroundJobs.refreshPollInterval();
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
        heartbeatMs: SSE_HEARTBEAT_MS,
        projects: projectsStore,
        features: featuresStore,
        canvasStore,
        sessionDataDir: dbDir,
        tmuxClient: DEFAULT_TMUX,
        gitClient: DEFAULT_GIT,
        agentStore,
        workStore,
        wakeScheduler: runtime.wakeScheduler,
        beforeAgentNewChatArchive: runtime.beforeNewChatArchive,
        beforeAgentSideThreadClose: runtime.beforeSideThreadClose,
        summarizeAgentSideConversation: runtime.summarizeSideConversation,
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
        pollTmux: (opts) => poller.poll(opts),
        computeProjectsState,
        tmuxListSessionsWithWindows,
        paneRuntimes,
        paneMetadata: paneMetadataStore,
        skills: { list: skills.list, refresh: skills.refresh },
        buildVoiceOrchestrator,
        uiContextRegistry,
        memoryDreamJob: () => memoryDreamJob
      };
    },
    startBackgroundJobs: () => backgroundJobs.start(),
    async dispose() {
      runtime.dispose();
      await Promise.race([
        paneRuntimes.tmux.dispose(),
        new Promise((resolve) => setTimeout(resolve, 500))
      ]);
    }
  };
}

function buildMemoryDreamJob(
  config: Config,
  input: {
    store: ReturnType<typeof createAppStores>["store"];
    agentStore: ReturnType<typeof createAppStores>["agentStore"];
  }
): MemoryDreamJob | null {
  const memoryDreamProviders = config.memory.dream.enabled
    ? buildProviderConfigs(config, "manager").map(createAgentProvider)
    : null;
  if (!memoryDreamProviders?.length) return null;
  const memoryDreamProvider =
    memoryDreamProviders[0] ?? createAgentProvider(buildProviderConfig(config, "manager"));
  const logRequests = normalizeLogRequests(config.agent.logRequests);
  const candidates = memoryDreamProviders.map((candidate) => ({
    model: candidate.model,
    provider: candidate.meta.provider,
    modelName: candidate.meta.model,
    baseURL: candidate.meta.baseURL,
    reasoningEffort: candidate.meta.reasoningEffort,
    supportsReasoning: candidate.meta.supportsReasoning,
    recorder: new AgentLlmCallRecorder({
      store: input.store,
      logRequests,
      provider: candidate.meta.provider,
      providerName: candidate.meta.providerName,
      model: candidate.meta.model,
      baseURL: candidate.meta.baseURL || "",
      apiMode: "streamText"
    })
  }));

  const memoryDreamer = new MemoryDreamer({
    db: input.store.db,
    memory: createAgentRuntimeMemoryManager({ config, store: input.store }),
    agentStore: input.agentStore,
    model: memoryDreamProvider.model,
    provider: memoryDreamProvider.meta.provider,
    modelName: memoryDreamProvider.meta.model,
    reasoningEffort: memoryDreamProvider.meta.reasoningEffort,
    supportsReasoning: memoryDreamProvider.meta.supportsReasoning,
    candidates
  });
  return new MemoryDreamJob({
    db: input.store.db,
    dreamer: memoryDreamer,
    idleMs: 60 * 60 * 1000,
    minIntervalMs: 12 * 60 * 60 * 1000
  });
}

function replaceConfigInPlace(target: Config, source: Config): void {
  for (const key of Object.keys(target) as Array<keyof Config>) {
    delete target[key];
  }
  Object.assign(target, source);
}
