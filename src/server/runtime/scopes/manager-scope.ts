import type { AgentStore } from "../../modules/agent/agent-store.js";
import type { FeatureRecordStore } from "../../modules/plans/record-store.js";
import type { ProjectsStore } from "../../modules/projects/projects-store.js";
import type { FeaturesStore } from "../../modules/features/features-store.js";
import type { WorkItemStore } from "../../modules/agent/work-item-store.js";
import type { SkillRegistry } from "../../modules/skills/skill-registry.js";
import { managerResourcesDir } from "../../platform/fs/resources.js";
import { ToolRegistry, ToolDispatcher } from "../../modules/agent/tool-registry.js";
import {
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

const SKILLS_REFRESH_THROTTLE_MS = 5 * 60 * 1000;

export interface ManagerScopeDeps {
  config?: Config;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  workStore?: WorkItemStore | null;
  skillRegistry: SkillRegistry;
  memory?: MemoryManager | null;
  /** Workers' task records, beside their plans: the memory section reads them. */
  records: FeatureRecordStore;
  toolPacks?: ToolPack[];
  /** Plans stand in the feature index and the briefing lines. */
  planStore?: PlanStore;
  /** A turn running, or a message waiting to start one. */
  isBusy?: (threadId: string) => boolean;
}

/** Build the manager-scope runtime: the cross-project planner with bash/file
 *  tools + lifecycle CRUD + UI nav tools. Work reaches a worker as a message. */
export function buildManagerScope(deps: ManagerScopeDeps): ScopeRuntime {
  const registry = new ToolRegistry();
  registerToolPacks(registry, "manager", deps.toolPacks ?? []);

  const dispatcher = new ToolDispatcher(registry);

  // Manager tools get their deps via factory closure; just pass ctx through.
  const wrappedDispatcher: WrappedDispatcher = {
    registry: { get tools() { return registry.tools; } },
    dispatch: async (call, ctx) => dispatcher.dispatch(call, ctx)
  };

  const memorySection = (threadId: string): string => {
    if (!deps.memory) return "";
    // The projects this thread's workers are in, most recently active first:
    // a worker's activity is its conversation, which leaves its feature row as it was.
    const activityOf = (feature: { id: string; updatedAt: string }) => {
      const thread = deps.agentStore.getThreadByScope("worker", feature.id);
      const last = thread ? deps.agentStore.lastActivityAt(thread.id) : null;
      return last ?? feature.updatedAt;
    };
    const projectIdsByActivity = [...new Set(
      deps.featuresStore.listActiveOwnedBy(threadId)
        .map((f) => ({ projectId: f.projectId, at: activityOf(f) }))
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((f) => f.projectId)
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
        availableSkillsSection: deps.skillRegistry.renderManifest("manager"),
        memorySection: memorySection(threadId)
      });
    },

    buildMemorySection: memorySection,

    async buildRuntimeContext(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) return null;
      const projects = deps.projectsStore.listActive();
      const all = deps.featuresStore.listAllActive();
      // This thread's workers, and unowned ones (anyone's); the rest belong
      // to other threads and are only counted.
      const features = all.filter((f) => f.ownerThreadId === threadId || f.ownerThreadId === null);
      const otherThreadWorkerCount = all.length - features.length;
      const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "(unknown)";
      // How the worker's last wake ended short, and whether one runs now: the
      // index line says Failed or Stopped as the worker's own page does.
      const workerRunning = (featureId: string) => {
        const worker = deps.agentStore.getThreadByScope("worker", featureId);
        return worker ? deps.isBusy?.(worker.id) ?? false : false;
      };
      const workerFacts = (featureId: string) => {
        const item = deps.workStore?.getByFeature(featureId);
        return {
          failure: item?.failedAt ? { at: item.failedAt, kind: item.failedKind ?? "error" as const } : null,
          running: workerRunning(featureId)
        };
      };
      const coreContext = buildManagerRuntimeContext({
        projects: projects.map((p) => ({
          id: p.id, name: p.name, workingDir: p.workingDir,
          isGit: p.isGit, gitRemote: p.gitRemote,
          featureCount: all.filter((f) => f.projectId === p.id).length
        })),
        features: features.map((f) => ({
          id: f.id, projectId: f.projectId, projectName: projectName(f.projectId),
          name: f.name, mode: f.mode, branch: f.branch ?? null, baseRef: f.baseRef ?? null,
          workingDir: f.worktreePath ?? null,
          primaryPaneStatus: "unknown",
          updatedAt: f.updatedAt,
          plan: deps.planStore?.get(f.id) ?? null,
          ...workerFacts(f.id)
        })),
        otherThreadWorkerCount
      });

      // Append the work-item wake section.
      if (deps.workStore) {
        const section = buildWorkItemWakeSection(threadId, deps.workStore, deps.agentStore, deps.planStore, workerRunning);
        if (section.trim()) return `${coreContext}\n\n${section}`;
      }

      return coreContext;
    },

    buildToolScope() {
      return {
        kind: "manager",
        managerDir: managerResourcesDir(),
        projectWorkingDirs: deps.projectsStore.listActive().map((p) => p.workingDir)
      };
    },

    wrappedDispatcher,
    get toolDefinitions() { return registry.definitions; }
  };
}
