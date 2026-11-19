import type { TaskBoardService } from "../modules/task-board/task-board-service.js";
import { buildTaskBoardTools } from "../modules/task-board/tools/task-board-tools.js";
import type { StickyNotesService } from "../modules/sticky-notes/sticky-notes-service.js";
import { buildStickyNotesTools } from "../modules/sticky-notes/tools/sticky-notes-tools.js";
import type { CalendarService } from "../modules/calendar/calendar-service.js";
import { buildCalendarTools } from "../modules/calendar/tools/calendar-tools.js";
import { localTimeZone } from "../platform/time/agent-time.js";
import { activeToolReviewRules } from "../modules/agent/system-prompt.js";
import type { MandateStore } from "../app/store.js";
import type { HeldBackSignal, WaitKind } from "../../shared/thread-dot.js";
import type { AgentScope, AgentStore } from "../modules/agent/agent-store.js";
import type { WakeScheduler } from "../modules/agent/wake-loop.js";
import type { PaneMonitorManager } from "../modules/agent/pane-monitor-manager.js";
import type { CommandMonitorManager } from "../modules/agent/command-monitor-manager.js";
import type { AgentAlarmManager } from "../modules/agent/agent-alarm-manager.js";
import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { CanvasStore } from "../modules/canvas/canvas-store.js";
import type { WorkersStore } from "../modules/workers/workers-store.js";
import type { MemoryManager } from "../modules/memory/manager.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import { WorkerRecordStore } from "../modules/plans/record-store.js";
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
import type { TmuxRuntime } from "./runtimes/tmux-runtime.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import type { ScopeRuntime } from "./scope.js";
import { buildScopesFromPacks } from "./scope-packs.js";
import { PERSONAL_FOREGROUND_MS, pickPersonalReusedTools } from "../modules/personal/personal-scope.js";
import { buildSkillTools } from "../modules/skills/tool-packs.js";
import { buildPersonalSubagentTool } from "../modules/agent/tools/subagent-tools.js";
import { buildPersonalActionTools, buildPersonalArchiveTools, buildPersonalLabelTools, buildPersonalReadTools } from "../modules/personal/personal-tools.js";
import type { ThreadArchive } from "../modules/agent/thread-archive.js";
import type { ThreadLabels } from "../modules/agent/thread-labels.js";
import type { HandoffService } from "../modules/personal/handoff-service.js";
import { toolPack } from "./tool-packs.js";
import { buildQuestionTools } from "../modules/agent/tools/question-tools.js";
import { buildNotifyTool } from "../modules/notifications/notify-tool.js";
import type { NotificationService } from "../modules/notifications/notification-service.js";
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
import type { ScheduleManager } from "../modules/schedules/schedule-manager.js";
import { buildScheduleTools } from "../modules/schedules/tools/schedule-tools.js";
import type { ScheduleStore } from "../modules/schedules/schedule-store.js";
import type { DutySummaryDto } from "../../shared/api/schedules.js";
import { createDutyThreads } from "../modules/schedules/duty-context.js";
import { createThreadNotes } from "../modules/agent/thread-notes.js";
import { displayPersonalAgentName } from "../../shared/personal-agent-name.js";

interface AgentRuntimeScopeDeps {
  config: Config;
  /** The live config (a reload replaces it in place; the getter keeps the
   *  personal agent's name current either way). */
  getConfig?: () => Config;
  store: MandateStore;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
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
  tmuxRuntime: TmuxRuntime;
  paneMetadata?: PaneMetadataStore;
  sessionDataDir?: string;
  paneMonitorManager: PaneMonitorManager;
  commandMonitorManager: CommandMonitorManager;
  alarmManager: AgentAlarmManager;
  /** Schedules: the personal agent's tools for them. */
  schedules?: ScheduleManager;
  /** The owner's task board: the personal agent's task tool, and its runtime section. */
  taskBoard?: TaskBoardService;
  /** The sticky notes the personal agent leaves for the user: its tool, and its runtime section. */
  stickyNotes?: StickyNotesService;
  /** The personal agent's calendar: its tool, and its runtime section. */
  calendar?: CalendarService;
  /** Which manager threads are on duty, and their context. */
  scheduleStore?: ScheduleStore;
  /** A thread's duty as its row shows it: a renamed thread is published with it. */
  dutySummary?: (threadId: string) => DutySummaryDto | null;
  /** The projects a thread's workers ran in: a renamed thread is published with them. */
  threadProjects?: (threadId: string) => readonly string[];
  memoryManager: MemoryManager;
  canvasStore: CanvasStore;
  getWakeScheduler: () => WakeScheduler;
  /** Lazy like `getWakeScheduler`: the sweep that backs this is constructed
   *  after the scopes are. */
  sweepController?: SweepController;
  /** The personal agent's handoffs; without it the personal agent can read but not act. */
  handoffs?: HandoffService;
  /** A manager asked the user a question in its thread. */
  onQuestionAsked?: (threadId: string, question: OpenQuestion) => void;
  /** A question asked of the user was taken back by its asker. */
  onQuestionWithdrawn?: (threadId: string, question: OpenQuestion) => void;
  /** Whether a conversation runs a turn (or holds a message that will start
   *  one), and what it sleeps on: what "the thread rests" is read from. */
  threadActivity?: { isBusy: (threadId: string) => boolean; waitKind: (threadId: string) => WaitKind | null; heldBack?: (threadId: string) => HeldBackSignal | null };
  /** The manager stop check's verdict that shows now (ManagerStopCheck.current): the personal agent
   *  reads blue rows as Home lists them. */
  verdictOf?: (threadId: string) => CurrentVerdict | null;
  /** The zone the personal agent's digest writes times in, as its messages do. */
  timeZone?: string;
  /** A worker wrote new questions into its plan. */
  onWorkerQuestion?: (workerId: string, questions: string[]) => void;
  /** Where the personal agent's notices go; without it the personal agent has no notify. */
  notifications?: Pick<NotificationService, "notify" | "channelChoices">;
  /** Archives a thread with its workers; without it the personal agent has no archive_thread. */
  threadArchive?: Pick<ThreadArchive, "archive">;
  /** The labels of manager threads; without it the personal agent has no label_thread. */
  threadLabels?: Pick<ThreadLabels, "add" | "remove">;
  beforeWorkerArchive?: (workerId: string) => void;
  /** What the `subagent` and `stop_task` tools start and stop. */
  subagents?: Pick<SubagentService, "start" | "stop">;
  /** A thread's running turn answers a person (the wake scheduler's): a page
   *  subagent the personal agent starts then wakes it at its end. */
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
  /** Personal agent's page folder: with it, its `subagent` tool starts page
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
    workersStore: deps.workersStore,
    workStore: deps.workStore,
    skillRegistry: deps.skillRegistry,
    paneMonitorManager: deps.paneMonitorManager,
    commandMonitorManager: deps.commandMonitorManager,
    alarmManager: deps.alarmManager,
    sweepController: deps.sweepController,
    memory: deps.memoryManager,
    canvasStore: deps.canvasStore,
    sse: deps.sse,
    getWakeScheduler: deps.getWakeScheduler,
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
    ...buildWorkerToolPacks({ paneMonitorManager: deps.paneMonitorManager })
  ];
  const planStore = new PlanStore(deps.store.db);
  const records = new WorkerRecordStore(deps.store.db);
  const managerToolPacks = [
    ...buildCommonToolPacks({ scope: "manager", ...commonToolPackContext }),
    ...buildManagerToolPacks({
      planStore,
      agentStore: deps.agentStore,
      projectsStore: deps.projectsStore,
      workersStore: deps.workersStore,
      workStore: deps.workStore,
      sessionDataDir: deps.sessionDataDir,
      tmuxClient: deps.tmuxClient,
      gitClient: deps.gitClient,
      tmuxRuntime: deps.tmuxRuntime,
      sse: deps.sse,
      publishLifecycle: deps.publishLifecycle,
      getSnapshot: deps.getSnapshot,
      beforeWorkerArchive: deps.beforeWorkerArchive,
      memory: deps.memoryManager,
      ...(deps.taskList ? { taskList: deps.taskList } : {}),
      ...(deps.dutySummary ? { dutySummary: deps.dutySummary } : {}),
      ...(deps.threadProjects ? { threadProjects: deps.threadProjects } : {})
    }),
    // A manager asks the user in its thread; whoever follows the thread hears
    // of the question as it is asked.
    toolPack("agent.questions", ["manager"], buildQuestionTools({
      openQuestions: (threadId) => deps.agentStore.openQuestions(threadId),
      onAsked: deps.onQuestionAsked,
      onWithdrawn: deps.onQuestionWithdrawn
    }))
  ];

  // The personal agent reuses the manager's read tools by name, plus its own.
  // Its shell is its own: a command still running after PERSONAL_FOREGROUND_MS
  // moves to the background, since the user cannot reach the agent while one
  // runs in the foreground.
  const personalBash = createBashTool({
    ...(deps.shellRunner ? { runner: deps.shellRunner } : {}),
    commands: deps.commands ?? null,
    foregroundMs: PERSONAL_FOREGROUND_MS
  }) as ToolDefinition;
  const personalToolPacks = [
    pickPersonalReusedTools(managerToolPacks, [
      personalBash,
      ...buildSkillTools(deps.skillRegistry, "personal"),
      // Its own `subagent`, which also starts the page subagent.
      ...(deps.subagents ? [buildPersonalSubagentTool({
        service: deps.subagents,
        isSubagentThread: (threadId) => deps.agentStore.getThreadById(threadId)?.scope === "subagent",
        answeringUser: deps.answeringPerson
      }) as ToolDefinition] : [])
    ]),
    toolPack("personal.read", ["personal"], buildPersonalReadTools({
      agentStore: deps.agentStore, workersStore: deps.workersStore, workStore: deps.workStore, projectsStore: deps.projectsStore,
      planStore, isBusy: deps.threadActivity?.isBusy, waitKind: deps.threadActivity?.waitKind, heldBack: deps.threadActivity?.heldBack,
      verdictOf: deps.verdictOf
    })),
    ...(deps.handoffs ? [toolPack("personal.act", ["personal"], buildPersonalActionTools({ handoffs: deps.handoffs, ...(deps.taskBoard ? { taskBoard: deps.taskBoard } : {}) }))] : []),
    // The task board is the personal agent's alone: managers never touch tasks.
    ...(deps.taskBoard ? [toolPack("personal.task-board", ["personal"], buildTaskBoardTools({
      taskBoard: deps.taskBoard, agentStore: deps.agentStore,
      agentName: () => displayPersonalAgentName((deps.getConfig ?? (() => deps.config))().agent.personalAgentName)
    }))] : []),
    // The sticky notes are the personal agent's alone: what it leaves for the user to read.
    ...(deps.stickyNotes ? [toolPack("personal.sticky-notes", ["personal"], buildStickyNotesTools({
      stickyNotes: deps.stickyNotes, agentStore: deps.agentStore, ...(deps.taskBoard ? { taskBoard: deps.taskBoard } : {})
    }))] : []),
    // The calendar is the personal agent's alone: what it planned for a time.
    ...(deps.calendar ? [toolPack("personal.calendar", ["personal"], buildCalendarTools({ calendar: deps.calendar, timeZone: deps.timeZone ?? localTimeZone() }))] : []),
    ...(deps.threadArchive ? [toolPack("personal.archive", ["personal"], buildPersonalArchiveTools({ threadArchive: deps.threadArchive }))] : []),
    ...(deps.threadLabels ? [toolPack("personal.labels", ["personal"], buildPersonalLabelTools({ threadLabels: deps.threadLabels }))] : []),
    // The agent asks on its own page; nobody stands above it to be told.
    toolPack("personal.questions", ["personal"], buildQuestionTools({ openQuestions: (threadId) => deps.agentStore.openQuestions(threadId) })),
    // Schedules are the personal agent's alone: no thread, worker or subagent gets them.
    ...(deps.schedules ? [toolPack("personal.schedules", ["personal"], buildScheduleTools({
      schedules: deps.schedules, threadTitle: (threadId) => deps.agentStore.getThreadById(threadId)?.title ?? null
    }))] : []),
    // Its own way to reach the user outside its conversation; not a subagent's.
    ...(deps.notifications ? [toolPack("personal.notify", ["personal"], [buildNotifyTool({
      service: deps.notifications, agentStore: deps.agentStore, workersStore: deps.workersStore
    }) as ToolDefinition])] : [])
  ];

  // A subagent's tools: each kind of parent's own, picked by name, so a
  // subagent is offered what its parent's model is offered.
  // Its shell runs in the foreground only, and its timeout kills: a command
  // outliving its one answer would land on a task already reported done.
  const subagentBash = createBashTool(deps.shellRunner ? { runner: deps.shellRunner } : {}) as ToolDefinition;
  const subagentToolPacks = {
    worker: pickSubagentTools("worker", workerToolPacks, subagentBash),
    manager: pickSubagentTools("manager", managerToolPacks, subagentBash),
    personal: pickSubagentTools("personal", personalToolPacks, subagentBash)
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
        workersStore: deps.workersStore,
        analyzer: deps.analyzer,
        tmuxClient: deps.tmuxClient,
        tmuxRuntime: deps.tmuxRuntime,
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
        workersStore: deps.workersStore,
        workStore: deps.workStore,
        skillRegistry: deps.skillRegistry,
        memory: deps.memoryManager,
        records,
        toolPacks: managerToolPacks,
        planStore,
        isBusy: deps.threadActivity?.isBusy,
        threadNotes: createThreadNotes({ agentStore: deps.agentStore }),
        ...(deps.scheduleStore ? { duty: createDutyThreads({
          store: deps.scheduleStore,
          agentName: () => displayPersonalAgentName((deps.getConfig ?? (() => deps.config))().agent.personalAgentName)
        }) } : {})
      },
      personal: {
        getConfig: deps.getConfig ?? (() => deps.config),
        agentStore: deps.agentStore,
        projectsStore: deps.projectsStore,
        workersStore: deps.workersStore,
        workStore: deps.workStore,
        planStore,
        skillRegistry: deps.skillRegistry,
        memory: deps.memoryManager,
        records,
        toolPacks: personalToolPacks,
        listOpenWaits: () => {
          const thread = deps.agentStore.openPersonalThread();
          return thread && deps.handoffs ? deps.handoffs.listOpenForContext(thread.id) : [];
        },
        isBusy: deps.threadActivity?.isBusy,
        waitKind: deps.threadActivity?.waitKind,
        heldBack: deps.threadActivity?.heldBack,
        verdictOf: deps.verdictOf,
        ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
        ...(deps.notifications ? { notificationChannels: () => deps.notifications!.channelChoices() } : {}),
        ...(deps.taskBoard ? { taskBoard: deps.taskBoard } : {}),
        ...(deps.stickyNotes ? { stickyNotes: deps.stickyNotes } : {}),
        ...(deps.calendar ? { calendar: deps.calendar } : {})
      },
      subagent: {
        agentStore: deps.agentStore,
        backgroundTasks: deps.backgroundTasks,
        workersStore: deps.workersStore,
        projectsStore: deps.projectsStore,
        toolPacks: subagentToolPacks,
        ...(deps.pageDir ? { page: { dir: deps.pageDir, toolPack: pickPageSubagentTools(personalToolPacks, subagentBash) } } : {}),
        toolReviewRules: () => activeToolReviewRules((deps.getConfig ?? (() => deps.config))()),
        parentToolScope: (parent) => {
          if (!scopes) throw new Error("agent scopes are not built yet");
          return scopes[parent.scope].buildToolScope(parent.id);
        }
      },
      sideChat: {
        personal: () => {
          if (!scopes) throw new Error("agent scopes are not built yet");
          return scopes.personal;
        },
        agentStore: deps.agentStore,
        ...(deps.pageDir ? { pageDir: deps.pageDir } : {})
      }
    }),
    ["worker", "manager", "personal", "subagent", "side_chat"]
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
