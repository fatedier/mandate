import type { AgentStore } from "../../modules/agent/agent-store.js";
import { withLearnedSkillGuidance } from "../../modules/skills/learned-skill-guidance.js";
import type { WorkerRecordStore } from "../../modules/plans/record-store.js";
import type { ProjectsStore } from "../../modules/projects/projects-store.js";
import type { WorkersStore } from "../../modules/workers/workers-store.js";
import type { WorkItemStore } from "../../modules/agent/work-item-store.js";
import type { SkillRegistry } from "../../modules/skills/skill-registry.js";
import { managerResourcesDir } from "../../platform/fs/resources.js";
import { ToolRegistry, ToolDispatcher } from "../../modules/agent/tool-registry.js";
import {
  activeToolReviewRules,
  buildManagerInitialContext,
  buildManagerRuntimeContext,
  buildManagerSystemPrompt
} from "../../modules/agent/system-prompt.js";
import { buildWorkItemWakeSection } from "../../modules/agent/wake-work-items-context.js";
import type { ScopeRuntime, WrappedDispatcher } from "../scope.js";
import { registerToolPacks, type ToolPack } from "../tool-packs.js";
import type { MemoryManager } from "../../modules/memory/manager.js";
import { buildMemorySection } from "../../modules/memory/context-section.js";
import type { Config } from "../../config.js";
import type { PlanStore } from "../../modules/plans/plan-store.js";
import type { WorkerPlanDto } from "../../../shared/api/plans.js";
import { ASK_TOOL, WITHDRAW_TOOL } from "../../../shared/questions.js";
import type { DutyThreads } from "../../modules/schedules/duty-context.js";
import type { ThreadNotes } from "../../modules/agent/thread-notes.js";

const SKILLS_REFRESH_THROTTLE_MS = 5 * 60 * 1000;

export interface ManagerScopeDeps {
  config?: Config;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
  workStore?: WorkItemStore | null;
  skillRegistry: SkillRegistry;
  memory?: MemoryManager | null;
  /** Workers' task records, beside their plans: the memory section reads them. */
  records: WorkerRecordStore;
  toolPacks?: ToolPack[];
  /** Plans stand in the worker index and the briefing lines. */
  planStore?: PlanStore;
  /** A turn running, or a message waiting to start one. */
  isBusy?: (threadId: string) => boolean;
  /** Duty threads (manager threads with schedules): their own context block,
   *  and no question to the owner (what needs the owner goes in their report). */
  duty?: DutyThreads;
  /** A long thread's notes: shown once it has been compacted a few times. */
  threadNotes?: ThreadNotes;
}

/** Tools a duty thread is not offered: it does not ask the owner. */
const DUTY_WITHHELD: ReadonlySet<string> = new Set([ASK_TOOL, WITHDRAW_TOOL]);

/** Build the manager-scope runtime: the cross-project planner with bash/file
 *  tools + lifecycle CRUD + UI nav tools. Work reaches a worker as a message. */
export function buildManagerScope(deps: ManagerScopeDeps): ScopeRuntime {
  const registry = new ToolRegistry();
  registerToolPacks(registry, "manager", deps.toolPacks ?? []);

  const dispatcher = new ToolDispatcher(registry);

  // Manager tools get their deps via factory closure; just pass ctx through.
  const wrappedDispatcher: WrappedDispatcher = {
    registry: { get tools() { return registry.tools; }, offeredSpecs: () => registry.offeredSpecs() },
    dispatch: async (call, ctx) => dispatcher.dispatch(call, ctx)
  };
  // A duty thread's: the same packs without the question tools, built once.
  let dutyDispatcher: WrappedDispatcher | null = null;
  const forDuty = (): WrappedDispatcher => {
    if (dutyDispatcher) return dutyDispatcher;
    const dutyRegistry = new ToolRegistry();
    registerToolPacks(dutyRegistry, "manager", (deps.toolPacks ?? []).map((pack) => ({
      ...pack, tools: pack.tools.filter((tool) => !DUTY_WITHHELD.has(tool.name))
    })));
    const dutyTools = new ToolDispatcher(dutyRegistry);
    dutyDispatcher = {
      registry: { get tools() { return dutyRegistry.tools; }, offeredSpecs: () => dutyRegistry.offeredSpecs() },
      dispatch: async (call, ctx) => dutyTools.dispatch(call, ctx)
    };
    return dutyDispatcher;
  };

  const memorySection = (threadId: string): string => {
    if (!deps.memory) return "";
    // The projects this thread's workers are in, most recently active first:
    // a worker's activity is its conversation, which leaves its worker row as it was.
    const activityOf = (worker: { id: string; updatedAt: string }) => {
      const thread = deps.agentStore.getThreadByScope("worker", worker.id);
      const last = thread ? deps.agentStore.lastActivityAt(thread.id) : null;
      return last ?? worker.updatedAt;
    };
    const projectIdsByActivity = [...new Set(
      deps.workersStore.listActiveOwnedBy(threadId)
        .map((w) => ({ projectId: w.projectId, at: activityOf(w) }))
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((w) => w.projectId)
    )];
    return buildMemorySection({
      memory: deps.memory,
      records: deps.records,
      projects: deps.projectsStore.listActive(),
      agent: { kind: "manager", projectIdsByActivity }
    });
  };

  return {
    scope: "manager",

    verifyScopeId(scopeId) {
      if (scopeId !== null) return "manager scope is a singleton (scopeId must be null)";
      return null;
    },

    async buildSystemPrompt(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) return "";
      return buildManagerSystemPrompt();
    },

    async buildInitialContext(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) return null;
      await deps.skillRegistry.maybeRefresh(SKILLS_REFRESH_THROTTLE_MS);
      return buildManagerInitialContext({
        managerDir: managerResourcesDir(),
        agentPreferences: deps.config?.agent.preferences,
        toolReviewRules: deps.config ? activeToolReviewRules(deps.config) : "",
        availableSkillsSection: withLearnedSkillGuidance("manager", deps.skillRegistry.renderManifest("manager", { threadId })),
        memorySection: memorySection(threadId)
      });
    },

    buildMemorySection: memorySection,

    async buildRuntimeContext(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) return null;
      const projects = deps.projectsStore.listActive();
      const all = deps.workersStore.listAllActive();
      // This thread's workers; the rest belong to other threads and are only
      // counted.
      const workers = all.filter((w) => w.ownerThreadId === threadId);
      const otherThreadWorkerCount = all.length - workers.length;
      const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "(unknown)";
      // How the worker's last wake ended short, and whether one runs now: the
      // index line says Failed or Stopped as the worker's view does.
      const workerRunning = (workerId: string) => {
        const worker = deps.agentStore.getThreadByScope("worker", workerId);
        return worker ? deps.isBusy?.(worker.id) ?? false : false;
      };
      // Each worker's plan read once: its index line and the work-item lines
      // below both show it.
      const plans = new Map<string, WorkerPlanDto>();
      const planOf = (workerId: string): WorkerPlanDto | null => {
        if (!deps.planStore) return null;
        const read = plans.get(workerId) ?? deps.planStore.get(workerId);
        plans.set(workerId, read);
        return read;
      };
      const workerFacts = (workerId: string) => {
        const item = deps.workStore?.getByWorker(workerId);
        return {
          failure: item?.failedAt && item.failedKind ? { at: item.failedAt, kind: item.failedKind } : null,
          running: workerRunning(workerId)
        };
      };
      const coreContext = buildManagerRuntimeContext({
        projects: projects.map((p) => ({
          id: p.id, name: p.name,
          workerCount: all.filter((w) => w.projectId === p.id).length
        })),
        workers: workers.map((worker) => ({
          id: worker.id, projectName: projectName(worker.projectId),
          name: worker.name, mode: worker.mode, branch: worker.branch ?? null, baseRef: worker.baseRef ?? null,
          updatedAt: worker.updatedAt,
          plan: planOf(worker.id),
          ...workerFacts(worker.id)
        })),
        otherThreadWorkerCount
      });

      const sections = [coreContext];
      // Append the work-item wake section.
      if (deps.workStore) {
        const plansOnce = deps.planStore
          ? { get: (workerId: string) => planOf(workerId)!, askingWorkerIds: () => deps.planStore!.askingWorkerIds() }
          : undefined;
        const section = buildWorkItemWakeSection(threadId, deps.workStore, deps.agentStore, plansOnce, workerRunning);
        if (section.trim()) sections.push(section);
      }
      // One or the other: a duty thread's block shows the same notes folder.
      const duty = deps.duty?.context(threadId);
      const notes = duty ? null : deps.threadNotes?.context(threadId);
      if (duty) sections.push(duty);
      else if (notes) sections.push(notes);
      return sections.join("\n\n");
    },

    buildToolScope() {
      return {
        kind: "manager",
        managerDir: managerResourcesDir(),
        projectWorkingDirs: deps.projectsStore.listActive().map((p) => p.workingDir)
      };
    },

    wrappedDispatcher,
    dispatcherForThread: (threadId) => (deps.duty?.isDutyThread(threadId) ? forDuty() : wrappedDispatcher),
    get toolDefinitions() { return registry.definitions; }
  };
}
