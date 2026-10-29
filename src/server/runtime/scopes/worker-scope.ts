import type { AgentStore } from "../../modules/agent/agent-store.js";
import type { FeatureRecordStore } from "../../modules/plans/record-store.js";
import { CommandDidNotAnswerError } from "../../platform/process/command-runner.js";
import type { ProjectsStore } from "../../modules/projects/projects-store.js";
import type { FeaturesStore } from "../../modules/features/features-store.js";
import type { Analyzer } from "../../modules/analysis/analyzer.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { FeatureRow } from "../../modules/features/features-store.js";
import type { ProjectRow } from "../../modules/projects/projects-store.js";
import type { TmuxRuntime } from "../runtimes/tmux-runtime.js";
import type { PaneRuntimeRegistry } from "../pane-runtime-registry.js";
import type { PaneMetadataStore } from "../../modules/panes/pane-metadata-store.js";
import type { SkillRegistry } from "../../modules/skills/skill-registry.js";
import { ToolRegistry, ToolDispatcher } from "../../modules/agent/tool-registry.js";
import {
  buildWorkerInitialContext,
  buildWorkerSystemPrompt,
  buildWorkerRuntimeContext,
  type PaneCtx
} from "../../modules/agent/system-prompt.js";
import type { ScopeRuntime, WrappedDispatcher } from "../scope.js";
import { registerToolPacks, type ToolPack } from "../tool-packs.js";
import type { MemoryManager } from "../../modules/memory/manager.js";
import { buildMemorySection } from "../../modules/memory/context-section.js";
import type { Config } from "../../config.js";
import type { PlanStore } from "../../modules/plans/plan-store.js";
import { renderPlanText } from "../../../shared/plan-text.js";

const SKILLS_REFRESH_THROTTLE_MS = 5 * 60 * 1000;

export interface WorkerScopeDeps {
  config?: Config;
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  analyzer: Analyzer;
  tmuxClient: TmuxClient;
  /** Per-project pane runtime resolver. Injected into ctx so pane tools
   *  dispatch via the project pane runtime. */
  paneRuntimes: PaneRuntimeRegistry;
  paneMetadata?: PaneMetadataStore;
  skillRegistry: SkillRegistry;
  memory?: MemoryManager | null;
  /** Workers' task records, beside their plans: the memory section reads them. */
  records: FeatureRecordStore;
  toolPacks?: ToolPack[];
  /** Read at each initial-context build, so the context appended after a
   *  compaction carries the plan as it is then. */
  planStore?: PlanStore;
}

/** Build the worker-scope runtime: the per-feature worker that runs in a
 *  single feature window, has bash/file/pane tools, and gets ctx augmented
 *  with the feature/project/tmuxClient/analyzer the pane tools need. */
export function buildWorkerScope(deps: WorkerScopeDeps): ScopeRuntime {
  const registry = new ToolRegistry();
  registerToolPacks(registry, "worker", deps.toolPacks ?? []);

  const dispatcher = new ToolDispatcher(registry);

  const wrappedDispatcher: WrappedDispatcher = {
    registry: { get tools() { return registry.tools; } },
    dispatch: async (call, ctx) => {
      const thread = deps.agentStore.getThreadById(ctx.threadId);
      if (!thread || !thread.scopeId) return { isError: true, error: "thread not found" };
      const feature = deps.featuresStore.getById(thread.scopeId);
      if (!feature) return { isError: true, error: "feature not found" };
      const project = deps.projectsStore.getById(feature.projectId);
      if (!project) return { isError: true, error: "project not found" };
      return dispatcher.dispatch(call, {
        ...ctx, feature, project,
        tmuxClient: deps.tmuxClient,
        analyzer: deps.analyzer,
        paneRuntime: deps.paneRuntimes.forProject(project.id),
        paneMetadata: deps.paneMetadata
      });
    }
  };

  const memorySection = (threadId: string): string => {
    const thread = deps.agentStore.getThreadById(threadId);
    const feature = thread?.scopeId ? deps.featuresStore.getById(thread.scopeId) : null;
    if (!deps.memory || !feature) return "";
    return buildMemorySection({
      memory: deps.memory,
      records: deps.records,
      projects: deps.projectsStore.listActive(),
      agent: { kind: "worker", projectId: feature.projectId, featureId: feature.id }
    });
  };

  return {
    scope: "worker",

    verifyScopeId(scopeId) {
      if (!scopeId) return "worker scope requires a featureId";
      const feature = deps.featuresStore.getById(scopeId);
      if (!feature || feature.archivedAt) return "feature not found or archived";
      return null;
    },

    async buildSystemPrompt(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || !thread.scopeId) return "";
      return buildWorkerSystemPrompt();
    },

    async buildInitialContext(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || !thread.scopeId) return null;
      await deps.skillRegistry.maybeRefresh(SKILLS_REFRESH_THROTTLE_MS);
      const feature = deps.featuresStore.getById(thread.scopeId);
      if (!feature) return null;
      const project = deps.projectsStore.getById(feature.projectId);
      if (!project) return null;
      return buildWorkerInitialContext({
        project: {
          id: project.id, name: project.name, workingDir: project.workingDir,
          isGit: project.isGit, gitRemote: project.gitRemote,
          tmuxSessionName: project.tmuxSessionName
        },
        feature: {
          id: feature.id, name: feature.name, tmuxWindowName: feature.tmuxWindowName,
          mode: feature.mode, branch: feature.branch, baseRef: feature.baseRef,
          worktreePath: feature.worktreePath
        },
        agentPreferences: deps.config?.agent.preferences,
        availableSkillsSection: deps.skillRegistry.renderManifest("worker"),
        planSection: deps.planStore ? renderPlanText(deps.planStore.get(feature.id)) : undefined,
        memorySection: memorySection(threadId)
      });
    },

    buildMemorySection: memorySection,

    async buildRuntimeContext(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || !thread.scopeId) return null;
      const feature = deps.featuresStore.getById(thread.scopeId);
      if (!feature) return null;
      const project = deps.projectsStore.getById(feature.projectId);
      if (!project) return null;
      const panes = await paneContextFor({
        project,
        feature,
        paneRuntime: deps.paneRuntimes.forProject(project.id),
        paneMetadata: deps.paneMetadata,
        analyzer: deps.analyzer
      });
      return buildWorkerRuntimeContext({ panes });
    },

    buildToolScope(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) throw new Error(`thread not found: ${threadId}`);
      const feature = deps.featuresStore.getById(thread.scopeId!);
      const project = feature ? deps.projectsStore.getById(feature.projectId) : null;
      if (!feature || !project) throw new Error(`feature or project missing for thread ${threadId}`);
      return {
        kind: "worker",
        feature: { workingDir: feature.worktreePath ?? null },
        project: { workingDir: project.workingDir }
      };
    },

    wrappedDispatcher,
    get toolDefinitions() { return registry.definitions; }
  };
}

/** The worker's panes for its context; null when tmux did not answer, so
 *  the context says so rather than that there are none. */
export async function paneContextFor(input: {
  project: ProjectRow;
  feature: FeatureRow;
  paneRuntime: TmuxRuntime;
  paneMetadata?: PaneMetadataStore;
  analyzer: Analyzer;
}): Promise<PaneCtx[] | null> {
  let panes: Awaited<ReturnType<TmuxRuntime["listPanes"]>>;
  try {
    panes = await input.paneRuntime.listPanes(input.feature.id);
  } catch (err) {
    if (err instanceof CommandDidNotAnswerError) return null;
    return [];
  }
  return panes.map((pane) => {
    const metadata = input.paneMetadata?.get(pane.id);
    // What the screen heuristics decided, for a live pane; an exited pane is
    // dead whatever its last screen showed, and a status they could not
    // decide says less than the lifecycle, so that stands in for both.
    const cached = pane.status === "running" ? input.analyzer.getCachedAnalysis(pane.id) : null;
    const analysed = cached && cached.status !== "unknown" ? cached : null;
    return {
      paneId: pane.id,
      ...(metadata?.name ? { name: metadata.name } : {}),
      ...(metadata?.description ? { description: metadata.description } : {}),
      command: pane.command.join(" ") || "(shell)",
      cwd: pane.cwd,
      status: analysed?.status ?? pane.status,
      summary: analysed?.summary ?? ""
    };
  });
}
