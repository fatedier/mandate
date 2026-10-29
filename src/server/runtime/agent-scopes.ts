import type { MandateStore } from "../app/store.js";
import type { WaitKind } from "../../shared/thread-dot.js";
import type { AgentScope, AgentStore } from "../modules/agent/agent-store.js";
import type { AgentUserMessageQueue } from "../modules/agent/user-message-queue.js";
import type { WakeScheduler } from "../modules/agent/wake-loop.js";
import type { WindowWatchManager } from "../modules/agent/window-watch-manager.js";
import type { CommandMonitorManager } from "../modules/agent/command-monitor-manager.js";
import type { AgentAlarmManager } from "../modules/agent/agent-alarm-manager.js";
import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { CanvasStore } from "../modules/canvas/canvas-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { MemoryManager } from "../modules/memory/manager.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import { FeatureRecordStore } from "../modules/plans/record-store.js";
import { PlanStore } from "../modules/plans/plan-store.js";
import type { SweepController } from "../modules/agent/tools/sweep-tools.js";
import {
  buildAgentScopePacks,
  buildCommonToolPacks,
  buildWorkerToolPacks,
  buildManagerToolPacks
} from "../modules/registry.js";
import type { CommonToolPackContext } from "../modules/module.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { SkillRegistry } from "../modules/skills/skill-registry.js";
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
import { GLOBAL_FOREGROUND_MS, pickGlobalReusedTools } from "../modules/global/global-scope.js";
import { buildSkillTools } from "../modules/skills/tool-packs.js";
import { buildGlobalSubagentTool } from "../modules/agent/tools/subagent-tools.js";
import { buildGlobalActionTools, buildGlobalArchiveTools, buildGlobalReadTools } from "../modules/global/global-tools.js";
import type { ThreadArchive } from "../modules/agent/thread-archive.js";
import type { HandoffService } from "../modules/global/handoff-service.js";
import { toolPack } from "./tool-packs.js";
import { buildQuestionTools } from "../modules/agent/tools/question-tools.js";
import type { OpenQuestion } from "../../shared/questions.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";
import type { SubagentService } from "./subagents.js";
import type { BackgroundCommandService } from "./background-commands.js";
import type { TaskList } from "./task-list.js";
import type { ShellCommandRunner } from "../platform/process/shell-command-runner.js";
import { createBashTool } from "../modules/agent/tools/bash.js";
import type { ToolDefinition } from "../modules/agent/tool-registry.js";
import type { ConversationScope } from "../../shared/api/agents.js";
import type { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import { conversationScopeOf } from "../modules/agent/subagent-threads.js";
import { pickPageSubagentTools, pickSubagentTools } from "./scopes/subagent-scope.js";
import type { WebTools } from "../modules/web/web-tools.js";
import type { CurrentVerdict } from "../../shared/api/thread-status.js";

interface AgentRuntimeScopeDeps {
  config: Config;
  /** The live config (a reload replaces it in place; the getter keeps the
   *  global agent's name current either way). */
  getConfig?: () => Config;
  store: MandateStore;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  workStore: WorkItemStore;
  /** The subagents' tasks: a subagent's thread reaches its parent through them. */
  backgroundTasks: BackgroundTaskStore;
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
  windowWatchManager: WindowWatchManager;
  commandMonitorManager: CommandMonitorManager;
  alarmManager: AgentAlarmManager;
  memoryManager: MemoryManager;
  canvasStore: CanvasStore;
  getWakeScheduler: () => WakeScheduler;
  /** Lazy like `getWakeScheduler`: the heartbeat that backs this is constructed
   *  after the scopes are. */
  sweepController?: SweepController;
  userMessageQueue?: Pick<AgentUserMessageQueue, "submitThreadUserMessage">;
  /** The global agent's handoffs; without it the global agent can read but not act. */
  handoffs?: HandoffService;
  /** A manager asked the user a question in its thread. */
  onQuestionAsked?: (threadId: string, question: OpenQuestion) => void;
  /** A question asked of the user was taken back by its asker. */
  onQuestionWithdrawn?: (threadId: string, question: OpenQuestion) => void;
  /** Whether a conversation runs a turn (or holds a message that will start
   *  one), and what it sleeps on: what "the thread rests" is read from. */
  threadActivity?: { isBusy: (threadId: string) => boolean; waitKind: (threadId: string) => WaitKind | null };
  /** The manager stop check's verdict that shows now (ManagerStopCheck.current): Your agent
   *  reads blue rows as Home lists them. */
  verdictOf?: (threadId: string) => CurrentVerdict | null;
  /** The zone Your agent's digest writes times in, as its messages do. */
  timeZone?: string;
  /** A worker wrote new questions into its plan. */
  onWorkerQuestion?: (featureId: string, questions: string[]) => void;
  /** Archives a thread with its workers; without it the global agent has no archive_thread. */
  threadArchive?: Pick<ThreadArchive, "archive">;
  beforeFeatureArchive?: (featureId: string) => void;
  /** What the `subagent` and `stop_task` tools start and stop. */
  subagents?: Pick<SubagentService, "start" | "stop">;
  /** A thread's running turn answers a person (the wake scheduler's): a page
   *  subagent Your agent starts then wakes it at its end. */
  answeringPerson?: (threadId: string) => boolean;
  /** What bash runs in the background, and moves there at its timeout;
   *  stop_task stops them. */
  commands?: Pick<BackgroundCommandService, "start" | "adopt" | "stop">;
  /** A conversation's queued and running tasks. */
  taskList?: TaskList;
  /** What runs bash's commands; the login-shell runner unless a test's. */
  shellRunner?: ShellCommandRunner;
  /** web_search and web_fetch for every agent. */
  web?: WebTools;
  /** Your agent's page folder: with it, its `subagent` tool starts page
   *  subagents, which work there. */
  pageDir?: string;
  supportsInputForScope?: (scope: ConversationScope, input: ModelInputType) => boolean;
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  supportsToolResultImagesForThread?: (threadId: string) => boolean;
}

export function createAgentRuntimeScopes(
  deps: AgentRuntimeScopeDeps
): Record<AgentScope, ScopeRuntime> {
  // A subagent's thread is checked as the thread it works for.
  const conversationScope = (threadId: string) =>
    conversationScopeOf({ agentStore: deps.agentStore, backgroundTasks: deps.backgroundTasks }, threadId);
  const supportsInputForScope = deps.supportsInputForScope ??
    ((scope: ConversationScope, input: ModelInputType): boolean => {
      if (input === "text") return true;
      return modelSupportsInput(deps.config, deps.config.agent[scope].modelRef, input);
    });
  const supportsInputForThread = deps.supportsInputForThread ??
    ((threadId: string, input: ModelInputType): boolean =>
      supportsInputForScope(conversationScope(threadId) ?? "worker", input));
  const supportsToolResultImagesForThread = deps.supportsToolResultImagesForThread ??
    ((threadId: string): boolean => {
      const scope = conversationScope(threadId);
      const provider = scope && scope !== "worker" ? deps.config.agent.manager : deps.config.agent.worker;
      return supportsInputForThread(threadId, "image") && providerSupportsToolResultImages(provider);
    });

  const commonToolPackContext = {
    store: deps.store,
    agentStore: deps.agentStore,
    projectsStore: deps.projectsStore,
    featuresStore: deps.featuresStore,
    workStore: deps.workStore,
    skillRegistry: deps.skillRegistry,
    watchManager: deps.windowWatchManager,
    commandMonitorManager: deps.commandMonitorManager,
    alarmManager: deps.alarmManager,
    sweepController: deps.sweepController,
    memory: deps.memoryManager,
    canvasStore: deps.canvasStore,
    sse: deps.sse,
    getWakeScheduler: deps.getWakeScheduler,
    userMessageQueue: deps.userMessageQueue,
    onWorkerQuestion: deps.onWorkerQuestion,
    subagents: deps.subagents,
    ...(deps.commands ? { commands: deps.commands } : {}),
    ...(deps.shellRunner ? { shellRunner: deps.shellRunner } : {}),
    ...(deps.taskList ? { taskList: deps.taskList } : {}),
    ...(deps.web ? { web: deps.web } : {}),
    supportsInputForScope,
    supportsInputForThread,
    supportsToolResultImagesForThread
  } satisfies Omit<CommonToolPackContext, "scope">;
  const workerToolPacks = [
    ...buildCommonToolPacks({ scope: "worker", ...commonToolPackContext }),
    ...buildWorkerToolPacks({ watchManager: deps.windowWatchManager })
  ];
  const planStore = new PlanStore(deps.store.db);
  const records = new FeatureRecordStore(deps.store.db);
  const managerToolPacks = [
    ...buildCommonToolPacks({ scope: "manager", ...commonToolPackContext }),
    ...buildManagerToolPacks({
      planStore,
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
      beforeFeatureArchive: deps.beforeFeatureArchive,
      memory: deps.memoryManager,
      ...(deps.taskList ? { taskList: deps.taskList } : {})
    }),
    // A manager asks the user in its thread; whoever follows the thread hears
    // of the question as it is asked.
    toolPack("agent.questions", ["manager"], buildQuestionTools({
      openQuestions: (threadId) => deps.agentStore.openQuestions(threadId),
      onAsked: deps.onQuestionAsked,
      onWithdrawn: deps.onQuestionWithdrawn
    }))
  ];

  // The global agent reuses the manager's read tools by name, plus its own.
  // Its shell is its own: a command still running after GLOBAL_FOREGROUND_MS
  // moves to the background, since the user cannot reach the agent while one
  // runs in the foreground.
  const globalBash = createBashTool({
    ...(deps.shellRunner ? { runner: deps.shellRunner } : {}),
    commands: deps.commands ?? null,
    foregroundMs: GLOBAL_FOREGROUND_MS
  }) as ToolDefinition;
  const globalToolPacks = [
    pickGlobalReusedTools(managerToolPacks, [
      globalBash,
      ...buildSkillTools(deps.skillRegistry, "global"),
      // Its own `subagent`, which also starts the page subagent.
      ...(deps.subagents ? [buildGlobalSubagentTool({
        service: deps.subagents,
        isSubagentThread: (threadId) => deps.agentStore.getThreadById(threadId)?.scope === "subagent",
        answeringUser: deps.answeringPerson
      }) as ToolDefinition] : [])
    ]),
    toolPack("global.read", ["global"], buildGlobalReadTools({
      agentStore: deps.agentStore, featuresStore: deps.featuresStore, workStore: deps.workStore, projectsStore: deps.projectsStore,
      planStore, isBusy: deps.threadActivity?.isBusy, waitKind: deps.threadActivity?.waitKind, verdictOf: deps.verdictOf
    })),
    ...(deps.handoffs ? [toolPack("global.act", ["global"], buildGlobalActionTools({ handoffs: deps.handoffs }))] : []),
    ...(deps.threadArchive ? [toolPack("global.archive", ["global"], buildGlobalArchiveTools({ threadArchive: deps.threadArchive }))] : []),
    // The agent asks on its own page; nobody stands above it to be told.
    toolPack("global.questions", ["global"], buildQuestionTools({ openQuestions: (threadId) => deps.agentStore.openQuestions(threadId) }))
  ];

  // A subagent's tools: each kind of parent's own, picked by name, so a
  // subagent is offered what its parent's model is offered.
  // Its shell runs in the foreground only, and its timeout kills: a command
  // outliving its one answer would land on a task already reported done.
  const subagentBash = createBashTool(deps.shellRunner ? { runner: deps.shellRunner } : {}) as ToolDefinition;
  const subagentToolPacks = {
    worker: pickSubagentTools("worker", workerToolPacks, subagentBash),
    manager: pickSubagentTools("manager", managerToolPacks, subagentBash),
    global: pickSubagentTools("global", globalToolPacks, subagentBash)
  };
  // Read when a subagent's call needs its parent's tool scope, by which time
  // every scope is built.
  let scopes: Record<AgentScope, ScopeRuntime> | null = null;

  scopes = buildScopesFromPacks(
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
        records,
        toolPacks: workerToolPacks,
        planStore
      },
      manager: {
        config: deps.config,
        agentStore: deps.agentStore,
        projectsStore: deps.projectsStore,
        featuresStore: deps.featuresStore,
        workStore: deps.workStore,
        skillRegistry: deps.skillRegistry,
        memory: deps.memoryManager,
        records,
        toolPacks: managerToolPacks,
        planStore,
        isBusy: deps.threadActivity?.isBusy
      },
      global: {
        getConfig: deps.getConfig ?? (() => deps.config),
        agentStore: deps.agentStore,
        projectsStore: deps.projectsStore,
        featuresStore: deps.featuresStore,
        workStore: deps.workStore,
        planStore,
        skillRegistry: deps.skillRegistry,
        memory: deps.memoryManager,
        records,
        toolPacks: globalToolPacks,
        listOpenWaits: () => {
          const thread = deps.agentStore.openGlobalThread();
          return thread && deps.handoffs ? deps.handoffs.listOpenForContext(thread.id) : [];
        },
        isBusy: deps.threadActivity?.isBusy,
        waitKind: deps.threadActivity?.waitKind,
        verdictOf: deps.verdictOf,
        ...(deps.timeZone ? { timeZone: deps.timeZone } : {})
      },
      subagent: {
        agentStore: deps.agentStore,
        backgroundTasks: deps.backgroundTasks,
        featuresStore: deps.featuresStore,
        projectsStore: deps.projectsStore,
        toolPacks: subagentToolPacks,
        ...(deps.pageDir ? { page: { dir: deps.pageDir, toolPack: pickPageSubagentTools(globalToolPacks, subagentBash) } } : {}),
        parentToolScope: (parent) => {
          if (!scopes) throw new Error("agent scopes are not built yet");
          return scopes[parent.scope].buildToolScope(parent.id);
        }
      }
    }),
    ["worker", "manager", "global", "subagent"]
  );
  return scopes;
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
