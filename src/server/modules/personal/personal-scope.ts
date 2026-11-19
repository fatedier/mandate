import type { TaskBoardService } from "../task-board/task-board-service.js";
import { withLearnedSkillGuidance } from "../skills/learned-skill-guidance.js";
import { renderTasksSection } from "../task-board/task-text.js";
import type { StickyNotesService } from "../sticky-notes/sticky-notes-service.js";
import { stickyNotesSection } from "../sticky-notes/sticky-notes-text.js";
import type { CalendarService } from "../calendar/calendar-service.js";
import { renderCalendarSection } from "../calendar/calendar-text.js";
import { CALENDAR_LIMITS } from "../../../shared/api/calendar.js";
import { activeToolReviewRules, renderToolReviewRules } from "../agent/system-prompt.js";
import { localTimeZone } from "../../platform/time/agent-time.js";
import * as path from "node:path";
import type { AgentStore } from "../agent/agent-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import type { PlanStore } from "../plans/plan-store.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { MemoryManager } from "../memory/manager.js";
import { buildMemorySection } from "../memory/context-section.js";
import type { WorkerRecordStore } from "../plans/record-store.js";
import type { Config } from "../../config.js";
import type { ScopeRuntime, WrappedDispatcher } from "../../runtime/scope.js";
import { registerToolPacks, toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import { ToolDispatcher, ToolRegistry, type ToolDefinition } from "../agent/tool-registry.js";
import { ManagerThreadService } from "../agent/manager-threads.js";
import { personalAgentDir } from "../../platform/fs/resources.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import { displayPersonalAgentName } from "../../../shared/personal-agent-name.js";
import { ASKING_LABEL, isAsking, WAITING_LABEL, waitingOnYou } from "../../../shared/worker-state.js";
import type { HeldBackSignal, WaitKind } from "../../../shared/thread-dot.js";
import { readNotesIndex, renderPersonalRuntimeContext, type PersonalContextInput } from "./personal-context.js";
import { attentionInputs, listWaitingOnUser } from "./waiting-on-user.js";
import { threadContextWord, threadStates } from "./thread-status.js";
import systemPromptPath from "./prompts/personal.md" with { type: "file" };
import type { CurrentVerdict } from "../../../shared/api/thread-status.js";


/** The manager tools the personal agent uses as they are: the ones that read
 *  (they already ignore which thread owns a worker), the shell and `read`,
 *  and `write`, `edit` and its own
 *  alarms: it keeps notes in a working directory of its own and sets when it
 *  looks again; `subagent` with `stop_task`, to hand a self-contained
 *  job to a subagent; `create_project` and `archive_project`: adding a
 *  repository on this machine as a project, or archiving one, is the user's
 *  own setup, not a change to any project's code; and the canvas tools, for
 *  canvases of its own (a thread's canvas stays the thread's to change). What
 *  it should not change is a rule in its prompt. */
export const PERSONAL_REUSED_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "schedule_wake",
  "list_my_alarms",
  "cancel_alarm",
  "list_projects",
  "create_project",
  "archive_project",
  "list_workers",
  "get_worker_status",
  "read_worker_thread",
  "read_plan",
  "read_thread",
  "memory_search",
  "memory_read",
  "memory_remember",
  "memory_update",
  "memory_forget",
  "chat_history_search",
  "chat_history_read",
  "skill",
  "read_skill_reference",
  "manage_skill",
  "request_skill_review",
  "subagent",
  "stop_task",
  "list_tasks",
  "web_search",
  "web_fetch",
  "canvas"
]);

/** How long a command of the personal agent's runs in the foreground before
 *  it moves to the background: it is one conversation, and while its command
 *  runs the user cannot reach it. */
export const PERSONAL_FOREGROUND_MS = 30_000;

/** The personal agent's pack of reused tools: the manager's own instances
 *  of PERSONAL_REUSED_TOOLS, so they keep the manager's behaviour. A tool in
 *  `own` takes the place of the manager's of its name: its `bash`
 *  (PERSONAL_FOREGROUND_MS), and its skill tools, which read its own skills. */
export function pickPersonalReusedTools(managerToolPacks: readonly ToolPack[], own: readonly ToolDefinition[] = []): ToolPack {
  const byName = new Map(own.map((tool) => [tool.name, tool]));
  const tools = managerToolPacks
    .filter((pack) => pack.scopes.includes("manager"))
    .flatMap((pack) => pack.tools)
    .filter((tool) => PERSONAL_REUSED_TOOLS.has(tool.name))
    .map((tool) => byName.get(tool.name) ?? tool);
  return toolPack("personal.reused", ["personal"], tools);
}

export interface PersonalScopeDeps {
  getConfig: () => Config;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
  workStore: WorkItemStore;
  planStore: PlanStore;
  skillRegistry: SkillRegistry;
  memory: MemoryManager | null;
  /** Workers' task records, beside their plans: the memory section reads them. */
  records: WorkerRecordStore;
  /** Packs listing "personal": the reused manager tools (picked by name in
   *  agent-scopes) and the personal agent's own tools. */
  toolPacks: ToolPack[];
  /** The agent's working directory; its own under the data directory unless a test gives one. */
  workDir?: string;
  /** What the agent waits to hear from, for its context; none until it is wired. */
  listOpenWaits?: () => PersonalContextInput["waits"];
  /** A turn running, or a message waiting to start one; and what it sleeps
   *  on. They say whether a thread rests, which is when a worker's question
   *  nobody took up waits on the user. */
  isBusy?: (threadId: string) => boolean;
  waitKind?: (threadId: string) => WaitKind | null;
  /** The tool-call review's mark on a thread, if any. */
  heldBack?: (threadId: string) => HeldBackSignal | null;
  /** The manager stop check's verdict that shows now, for a thread that has stopped. */
  verdictOf?: (threadId: string) => CurrentVerdict | null;
  /** The zone the digest writes times in, as the messages do. Unset: the machine's. */
  timeZone?: string;
  /** The notification channels it can name, read as each context is built. */
  notificationChannels?: () => NonNullable<PersonalContextInput["channels"]>;
  /** The owner's task board; absent, the section reads "No open tasks." */
  taskBoard?: Pick<TaskBoardService, "list">;
  /** The sticky notes it left; absent, the section reads "None open." */
  stickyNotes?: Pick<StickyNotesService, "open" | "doneSince">;
  /** Its calendar; absent, the section reads "None." */
  calendar?: Pick<CalendarService, "entries" | "userChangesSince">;
}

/** The personal agent: sees every
 *  thread and worker, looks things up itself, sends work to threads and
 *  follows what it was handed to a result, with notes of its own. */
export function buildPersonalScope(deps: PersonalScopeDeps): ScopeRuntime {
  const registry = new ToolRegistry();
  registerToolPacks(registry, "personal", deps.toolPacks);
  const dispatcher = new ToolDispatcher(registry);
  const wrappedDispatcher: WrappedDispatcher = {
    registry: { get tools() { return registry.tools; }, offeredSpecs: () => registry.offeredSpecs() },
    dispatch: async (call, ctx) => dispatcher.dispatch(call, ctx)
  };
  const threads = new ManagerThreadService({ agentStore: deps.agentStore });
  const workDir = deps.workDir ?? personalAgentDir();
  const notesIndex = (): string | null => readNotesIndex(path.join(workDir, "notes"));
  const memorySection = (): string => (deps.memory
    ? buildMemorySection({ memory: deps.memory, records: deps.records, projects: deps.projectsStore.listActive(), agent: { kind: "personal" } })
    : "");

  return {
    scope: "personal",

    verifyScopeId(scopeId) {
      return scopeId === null ? null : "the personal scope has no scope id";
    },

    buildSystemPrompt() {
      // Its name, for the @ the user writes to it; a rename reaches the
      // prompt at the next compression, as the rest of it does.
      return renderPromptFile(systemPromptPath, { name: displayPersonalAgentName(deps.getConfig().agent.personalAgentName) });
    },

    async buildInitialContext() {
      await deps.skillRegistry.maybeRefresh(5 * 60 * 1000);
      // Every active project's skills: an archived project's are loaded by name only.
      const skills = withLearnedSkillGuidance("personal", deps.skillRegistry.renderManifest("personal", { projectIds: deps.projectsStore.listActive().map((p) => p.id) }));
      const rules = renderToolReviewRules(activeToolReviewRules(deps.getConfig()));
      const parts = [skills ? `## Available skills\n\n${skills}` : "", rules, memorySection()].filter(Boolean);
      return parts.length > 0 ? parts.join("\n\n") : null;
    },

    buildMemorySection: memorySection,

    async buildRuntimeContext(threadId) {
      if (!deps.agentStore.getThreadById(threadId)) return null;
      const projects = deps.projectsStore.listActive();
      const activeWorkers = deps.workersStore.listAllActive();
      const threadList = threads.list();
      // Every worker's plan read once, as its state reads it: the attention
      // facts and the workers' lines both need it, at every step of the agent.
      const plans = deps.planStore.statesOfActive();
      const planOf = (workerId: string) => plans.get(workerId) ?? null;
      const reads = { ...deps, planStore: { statesOfActive: () => plans } };
      // The one state each thread shows, read from the facts Home's list is.
      const inputs = attentionInputs(reads, threadList);
      const states = threadStates(inputs);
      const titleOf = (id: string | null) => (id ? threadList.find((t) => t.id === id)?.title ?? null : null);
      const workers = activeWorkers.map((worker) => {
        const item = deps.workStore.getByWorker(worker.id);
        const plan = planOf(worker.id);
        const waiting = waitingOnYou(item?.failedAt ?? null, item?.failedKind ?? null);
        const step = plan?.steps.find((s) => s.status === "in_progress" || s.status === "blocked");
        return {
          name: worker.name,
          projectName: projects.find((p) => p.id === worker.projectId)?.name ?? "(unknown)",
          ownerThreadTitle: titleOf(worker.ownerThreadId),
          // A worker that asked waits for an answer, from its manager first:
          // said on its line, and not among what waits on the user.
          waiting: waiting ? WAITING_LABEL[waiting] : isAsking(plan) ? ASKING_LABEL : null,
          currentStep: step ? step.title : null
        };
      });
      return renderPersonalRuntimeContext({
        name: displayPersonalAgentName(deps.getConfig().agent.personalAgentName),
        threads: inputs.threads.map((t, i) => ({
          title: t.title,
          lastActivityAt: threadList[i]!.lastActivityAt,
          state: threadContextWord(t, states.get(t.id) ?? "idle"),
          stopReason: t.failure?.kind === "stopped" ? t.failure.reason : null,
          workerCount: activeWorkers.filter((w) => w.ownerThreadId === t.id).length
        })),
        workers,
        // By the rule Home shows it by, blue rows included.
        waiting: listWaitingOnUser(reads, threadList, inputs).flatMap((item) => {
          if (item.kind === "thread") {
            // A thread that failed or was stopped is said on its own line above.
            return item.waiting === "failed" || item.waiting === "stopped" ? [] : [{ label: item.label, workerName: "manager", threadTitle: item.threadTitle }];
          }
          return [{
            label: item.label,
            workerName: item.kind === "worker" ? item.workerName : "manager",
            threadTitle: item.threadTitle,
            ...(item.question !== undefined ? { question: item.question } : {})
          }];
        }),
        waits: deps.listOpenWaits?.() ?? [],
        questions: deps.agentStore.openQuestions(threadId),
        workDir,
        notesIndex: notesIndex(),
        timeZone: deps.timeZone ?? localTimeZone(),
        channels: deps.notificationChannels?.() ?? [],
        ...(deps.taskBoard ? { tasksSection: renderTasksSection(deps.taskBoard.list(), { timeZone: deps.timeZone ?? localTimeZone(), now: Date.now() }) } : {}),
        ...(deps.stickyNotes ? { stickyNotesSection: stickyNotesSection(deps.stickyNotes, { timeZone: deps.timeZone ?? localTimeZone(), now: Date.now() }) } : {}),
        ...(deps.calendar ? { calendarSection: calendarSectionOf(deps.calendar, deps.timeZone ?? localTimeZone()) } : {})
      });
    },

    // Its shell starts in its own directory (its notes are there); its file
    // tools and its shell reach any path on the machine.
    buildToolScope() {
      return {
        kind: "manager",
        managerDir: workDir,
        projectWorkingDirs: deps.projectsStore.listActive().map((p) => p.workingDir)
      };
    },

    wrappedDispatcher,
    get toolDefinitions() { return registry.definitions; }
  };
}

/** The calendar's section: its entries and what the user changed in the last days it covers. */
function calendarSectionOf(calendar: Pick<CalendarService, "entries" | "userChangesSince">, timeZone: string): string {
  const now = Date.now();
  return renderCalendarSection(calendar.entries(), calendar.userChangesSince(now - CALENDAR_LIMITS.changesDays * 86_400_000), { timeZone, now });
}
