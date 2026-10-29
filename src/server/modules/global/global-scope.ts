import { readFileSync } from "node:fs";
import { localTimeZone } from "../../platform/time/agent-time.js";
import * as path from "node:path";
import type { AgentStore } from "../agent/agent-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import type { PlanStore } from "../plans/plan-store.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { MemoryManager } from "../memory/manager.js";
import { buildMemorySection } from "../memory/context-section.js";
import type { FeatureRecordStore } from "../plans/record-store.js";
import type { Config } from "../../config.js";
import type { ScopeRuntime, WrappedDispatcher } from "../../runtime/scope.js";
import { registerToolPacks, toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import { ToolDispatcher, ToolRegistry, type ToolDefinition } from "../agent/tool-registry.js";
import { ManagerThreadService } from "../agent/manager-threads.js";
import { globalAgentDir } from "../../platform/fs/resources.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import { displayGlobalAgentName } from "../../../shared/global-agent-name.js";
import { ASKING_LABEL, isAsking, WAITING_LABEL, waitingOnYou } from "../../../shared/feature-state.js";
import type { WaitKind } from "../../../shared/thread-dot.js";
import { renderGlobalRuntimeContext, type GlobalContextInput } from "./global-context.js";
import { attentionInputs, listWaitingOnUser } from "./waiting-on-user.js";
import { threadContextWord, threadStates } from "./thread-status.js";
import systemPromptPath from "./prompts/global.md" with { type: "file" };
import type { CurrentVerdict } from "../../../shared/api/thread-status.js";


/** The manager tools the global agent uses as they are: the ones that read
 *  (they already ignore which thread owns a worker), the shell and `read`,
 *  and `write`, `edit` and its own
 *  alarms: it keeps notes in a working directory of its own and sets when it
 *  looks again; `subagent` with `stop_task`, to hand a self-contained
 *  job to a subagent; and `create_project` and `archive_project`: adding a
 *  repository on this machine as a project, or archiving one, is the user's
 *  own setup, not a change to any project's code. What it should not change
 *  is a rule in its prompt. */
export const GLOBAL_REUSED_TOOLS: ReadonlySet<string> = new Set([
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
  "list_features",
  "get_feature_status",
  "read_feature_thread",
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
  "subagent",
  "stop_task",
  "list_tasks",
  "web_search",
  "web_fetch"
]);

/** How long a command of the global agent's runs in the foreground before
 *  it moves to the background: it is one conversation, and while its command
 *  runs the user cannot reach it. */
export const GLOBAL_FOREGROUND_MS = 30_000;

/** The global agent's pack of reused tools: the manager's own instances
 *  of GLOBAL_REUSED_TOOLS, so they keep the manager's behaviour. A tool in
 *  `own` takes the place of the manager's of its name: its `bash`
 *  (GLOBAL_FOREGROUND_MS), and its skill tools, which read its own skills. */
export function pickGlobalReusedTools(managerToolPacks: readonly ToolPack[], own: readonly ToolDefinition[] = []): ToolPack {
  const byName = new Map(own.map((tool) => [tool.name, tool]));
  const tools = managerToolPacks
    .filter((pack) => pack.scopes.includes("manager"))
    .flatMap((pack) => pack.tools)
    .filter((tool) => GLOBAL_REUSED_TOOLS.has(tool.name))
    .map((tool) => byName.get(tool.name) ?? tool);
  return toolPack("global.reused", ["global"], tools);
}

export interface GlobalScopeDeps {
  getConfig: () => Config;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  workStore: WorkItemStore;
  planStore: PlanStore;
  skillRegistry: SkillRegistry;
  memory: MemoryManager | null;
  /** Workers' task records, beside their plans: the memory section reads them. */
  records: FeatureRecordStore;
  /** Packs listing "global": the reused manager tools (picked by name in
   *  agent-scopes) and the global agent's own tools. */
  toolPacks: ToolPack[];
  /** The agent's working directory; its own under the data directory unless a test gives one. */
  workDir?: string;
  /** What the agent waits to hear from, for its context; none until it is wired. */
  listOpenWaits?: () => GlobalContextInput["waits"];
  /** A turn running, or a message waiting to start one; and what it sleeps
   *  on. They say whether a thread rests, which is when a worker's question
   *  nobody took up waits on the user. */
  isBusy?: (threadId: string) => boolean;
  waitKind?: (threadId: string) => WaitKind | null;
  /** The manager stop check's verdict that shows now, for a thread that has stopped. */
  verdictOf?: (threadId: string) => CurrentVerdict | null;
  /** The zone the digest writes times in, as the messages do. Unset: the machine's. */
  timeZone?: string;
}

/** The global agent: sees every
 *  thread and worker, looks things up itself, sends work to threads and
 *  follows what it was handed to a result, with notes of its own. */
export function buildGlobalScope(deps: GlobalScopeDeps): ScopeRuntime {
  const registry = new ToolRegistry();
  registerToolPacks(registry, "global", deps.toolPacks);
  const dispatcher = new ToolDispatcher(registry);
  const wrappedDispatcher: WrappedDispatcher = {
    registry: { get tools() { return registry.tools; } },
    dispatch: async (call, ctx) => dispatcher.dispatch(call, ctx)
  };
  const threads = new ManagerThreadService({ agentStore: deps.agentStore });
  const workDir = deps.workDir ?? globalAgentDir();
  const notesIndex = (): string | null => {
    try {
      return readFileSync(path.join(workDir, "notes", "index.md"), "utf8");
    } catch {
      return null;
    }
  };
  const memorySection = (): string => (deps.memory
    ? buildMemorySection({ memory: deps.memory, records: deps.records, projects: deps.projectsStore.listActive(), agent: { kind: "global" } })
    : "");

  return {
    scope: "global",

    verifyScopeId(scopeId) {
      return scopeId === null ? null : "the global scope has no scope id";
    },

    buildSystemPrompt() {
      return renderPromptFile(systemPromptPath, {});
    },

    async buildInitialContext() {
      await deps.skillRegistry.maybeRefresh(5 * 60 * 1000);
      const skills = deps.skillRegistry.renderManifest("global").trim();
      const parts = [skills ? `## Available skills\n\n${skills}` : "", memorySection()].filter(Boolean);
      return parts.length > 0 ? parts.join("\n\n") : null;
    },

    buildMemorySection: memorySection,

    async buildRuntimeContext(threadId) {
      if (!deps.agentStore.getThreadById(threadId)) return null;
      const projects = deps.projectsStore.listActive();
      const features = deps.featuresStore.listAllActive();
      const threadList = threads.list();
      // The one state each thread shows, read from the facts Home's list is.
      const inputs = attentionInputs(deps, threadList);
      const states = threadStates(inputs);
      const titleOf = (id: string | null) => (id ? threadList.find((t) => t.id === id)?.title ?? null : null);
      const workers = features.map((f) => {
        const item = deps.workStore.getByFeature(f.id);
        const plan = deps.planStore.get(f.id);
        const waiting = waitingOnYou(item?.failedAt ?? null, item?.failedKind ?? null);
        const step = plan?.steps.find((s) => s.status === "in_progress" || s.status === "blocked");
        return {
          name: f.name,
          projectName: projects.find((p) => p.id === f.projectId)?.name ?? "(unknown)",
          ownerThreadTitle: titleOf(f.ownerThreadId),
          // A worker that asked waits for an answer, from its manager first:
          // said on its line, and not among what waits on the user.
          waiting: waiting ? WAITING_LABEL[waiting] : isAsking(plan) ? ASKING_LABEL : null,
          currentStep: step ? step.title : null
        };
      });
      return renderGlobalRuntimeContext({
        name: displayGlobalAgentName(deps.getConfig().agent.globalAgentName),
        threads: inputs.threads.map((t, i) => ({
          title: t.title,
          lastActivityAt: threadList[i]!.lastActivityAt,
          state: threadContextWord(t, states.get(t.id) ?? "idle"),
          stopReason: t.failure?.kind === "stopped" ? t.failure.reason : null,
          workerCount: features.filter((f) => f.ownerThreadId === t.id).length
        })),
        workers,
        // By the rule Home shows it by, blue rows included.
        waiting: listWaitingOnUser(deps, threadList, inputs).flatMap((item) => {
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
        timeZone: deps.timeZone ?? localTimeZone()
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
