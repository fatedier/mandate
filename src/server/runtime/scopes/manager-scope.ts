import type { AgentStore } from "../../modules/agent/agent-store.js";
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
import type { Config } from "../../config.js";

const SKILLS_REFRESH_THROTTLE_MS = 5 * 60 * 1000;
const RUNTIME_MEMORY_ENTRY_LIMIT = 3;
const RUNTIME_MEMORY_ENTRY_MAX_CHARS = 500;

export interface ManagerScopeDeps {
  config?: Config;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  workStore?: WorkItemStore | null;
  skillRegistry: SkillRegistry;
  memory?: MemoryManager | null;
  toolPacks?: ToolPack[];
}

/** Extended manager scope that also holds the per-wake pending cleanup IDs.
 *  Callers should call `drainPendingMarks()` after a successful LLM wake. */
export interface ManagerScopeRuntime extends ScopeRuntime {
  /** Drain and return the pending cleanup IDs captured during the last
   *  buildRuntimeContext call. Must be called exactly once after each
   *  successful (finished/limit_reached) wake. Returns null if workStore
   *  was not provided or if there is nothing pending. */
  drainPendingMarks(): { processedEventIds: string[] } | null;
}

/** Build the manager-scope runtime: the cross-project planner with bash/file
 *  tools + lifecycle CRUD + UI nav tools. Feature work is dispatched into
 *  the worker's main task queue. */
export function buildManagerScope(deps: ManagerScopeDeps): ManagerScopeRuntime {
  const registry = new ToolRegistry();
  registerToolPacks(registry, "manager", deps.toolPacks ?? []);

  const dispatcher = new ToolDispatcher(registry);

  // Manager tools get their deps via factory closure; just pass ctx through.
  const wrappedDispatcher: WrappedDispatcher = {
    registry: { tools: registry.tools },
    dispatch: async (call, ctx) => dispatcher.dispatch(call, ctx)
  };

  // Mutable slot: the IDs from the most recent buildRuntimeContext call.
  // drainPendingMarks() consumes and clears this after each successful wake.
  let pendingMarks: { processedEventIds: string[] } | null = null;

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
        availableSkillsSection: deps.skillRegistry.renderManifest("manager")
      });
    },

    async buildRuntimeContext(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) return null;
      const lineageThreadId = deps.agentStore.lineageThreadId(threadId);
      const projects = deps.projectsStore.listActive();
      const features = deps.featuresStore.listAllActive();
      const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "(unknown)";
      const memorySection = deps.memory
        ? await deps.memory.buildPromptSection({ threadId: lineageThreadId }, {
            limit: RUNTIME_MEMORY_ENTRY_LIMIT,
            maxEntryChars: RUNTIME_MEMORY_ENTRY_MAX_CHARS
          })
        : "";
      const coreContext = buildManagerRuntimeContext({
        projects: projects.map((p) => ({
          id: p.id, name: p.name, workingDir: p.workingDir,
          isGit: p.isGit, gitRemote: p.gitRemote,
          featureCount: features.filter((f) => f.projectId === p.id).length
        })),
        features: features.map((f) => ({
          id: f.id, projectId: f.projectId, projectName: projectName(f.projectId),
          name: f.name, mode: f.mode, branch: f.branch ?? null, baseRef: f.baseRef ?? null,
          workingDir: f.worktreePath ?? null,
          primaryPaneStatus: "unknown",
          updatedAt: f.updatedAt,
          digest: deps.agentStore.getFeatureDigest(f.id)
        })),
        memorySection
      });

      // Append work-item wake section for manager threads.
      // Store the pending mark IDs — they are committed only after the LLM
      // turn succeeds (see drainPendingMarks).
      if (deps.workStore && thread.kind === "main") {
        const section = buildWorkItemWakeSection(
          threadId,
          deps.workStore,
          deps.agentStore
        );
        pendingMarks = {
          processedEventIds: section.processedEventIds
        };
        if (section.text.trim()) {
          return `${coreContext}\n\n${section.text}`;
        }
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

    drainPendingMarks() {
      if (!deps.workStore || !pendingMarks) return null;
      const marks = pendingMarks;
      pendingMarks = null;
      return marks;
    },

    wrappedDispatcher,
    toolDefinitions: registry.definitions
  };
}
