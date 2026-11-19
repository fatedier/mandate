import type { AgentStore } from "../../modules/agent/agent-store.js";
import { withLearnedSkillGuidance } from "../../modules/skills/learned-skill-guidance.js";
import type { WorkerRecordStore } from "../../modules/plans/record-store.js";
import { CommandDidNotAnswerError } from "../../platform/process/command-runner.js";
import type { ProjectsStore } from "../../modules/projects/projects-store.js";
import type { WorkersStore } from "../../modules/workers/workers-store.js";
import type { Analyzer } from "../../modules/analysis/analyzer.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { WorkerRow } from "../../modules/workers/workers-store.js";
import type { ProjectRow } from "../../modules/projects/projects-store.js";
import type { TmuxRuntime } from "../runtimes/tmux-runtime.js";
import type { PaneMetadataStore } from "../../modules/panes/pane-metadata-store.js";
import type { SkillRegistry } from "../../modules/skills/skill-registry.js";
import { ToolRegistry, ToolDispatcher } from "../../modules/agent/tool-registry.js";
import {
  activeToolReviewRules,
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
  workersStore: WorkersStore;
  analyzer: Analyzer;
  tmuxClient: TmuxClient;
  /** What a worker's pane tools act through, given to them in the tool context. */
  tmuxRuntime: TmuxRuntime;
  paneMetadata?: PaneMetadataStore;
  skillRegistry: SkillRegistry;
  memory?: MemoryManager | null;
  /** Workers' task records, beside their plans: the memory section reads them. */
  records: WorkerRecordStore;
  toolPacks?: ToolPack[];
  /** Read at each initial-context build, so the context appended after a
   *  compaction carries the plan as it is then. */
  planStore?: PlanStore;
}

/** Build the worker-scope runtime: the worker that runs in a
 *  single worker window, has bash/file/pane tools, and gets ctx augmented
 *  with the worker/project/tmuxClient/analyzer the pane tools need. */
export function buildWorkerScope(deps: WorkerScopeDeps): ScopeRuntime {
  const registry = new ToolRegistry();
  registerToolPacks(registry, "worker", deps.toolPacks ?? []);

  const dispatcher = new ToolDispatcher(registry);

  const wrappedDispatcher: WrappedDispatcher = {
    registry: { get tools() { return registry.tools; }, offeredSpecs: () => registry.offeredSpecs() },
    dispatch: async (call, ctx) => {
      const thread = deps.agentStore.getThreadById(ctx.threadId);
      if (!thread || !thread.scopeId) return { isError: true, error: "thread not found" };
      const worker = deps.workersStore.getById(thread.scopeId);
      if (!worker) return { isError: true, error: "worker not found" };
      const project = deps.projectsStore.getById(worker.projectId);
      if (!project) return { isError: true, error: "project not found" };
      return dispatcher.dispatch(call, {
        ...ctx, worker, project,
        tmuxClient: deps.tmuxClient,
        analyzer: deps.analyzer,
        paneRuntime: deps.tmuxRuntime,
        paneMetadata: deps.paneMetadata
      });
    }
  };

  const memorySection = (threadId: string): string => {
    const thread = deps.agentStore.getThreadById(threadId);
    const worker = thread?.scopeId ? deps.workersStore.getById(thread.scopeId) : null;
    if (!deps.memory || !worker) return "";
    return buildMemorySection({
      memory: deps.memory,
      records: deps.records,
      projects: deps.projectsStore.listActive(),
      agent: { kind: "worker", projectId: worker.projectId, workerId: worker.id }
    });
  };

  return {
    scope: "worker",

    verifyScopeId(scopeId) {
      if (!scopeId) return "worker scope requires a workerId";
      const worker = deps.workersStore.getById(scopeId);
      if (!worker || worker.archivedAt) return "worker not found or archived";
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
      const worker = deps.workersStore.getById(thread.scopeId);
      if (!worker) return null;
      const project = deps.projectsStore.getById(worker.projectId);
      if (!project) return null;
      return buildWorkerInitialContext({
        project: {
          id: project.id, name: project.name, workingDir: project.workingDir,
          isGit: project.isGit, gitRemote: project.gitRemote,
          tmuxSessionName: project.tmuxSessionName
        },
        worker: {
          id: worker.id, name: worker.name, tmuxWindowName: worker.tmuxWindowName,
          mode: worker.mode, branch: worker.branch, baseRef: worker.baseRef,
          worktreePath: worker.worktreePath
        },
        agentPreferences: deps.config?.agent.preferences,
        toolReviewRules: deps.config ? activeToolReviewRules(deps.config) : "",
        availableSkillsSection: withLearnedSkillGuidance("worker", deps.skillRegistry.renderManifest("worker", { projectIds: [project.id] })),
        planSection: deps.planStore ? renderPlanText(deps.planStore.get(worker.id)) : undefined,
        memorySection: memorySection(threadId)
      });
    },

    buildMemorySection: memorySection,

    async buildRuntimeContext(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || !thread.scopeId) return null;
      const worker = deps.workersStore.getById(thread.scopeId);
      if (!worker) return null;
      const project = deps.projectsStore.getById(worker.projectId);
      if (!project) return null;
      const panes = await paneContextFor({
        project,
        worker,
        paneRuntime: deps.tmuxRuntime,
        paneMetadata: deps.paneMetadata,
        analyzer: deps.analyzer
      });
      return buildWorkerRuntimeContext({ panes });
    },

    buildToolScope(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) throw new Error(`thread not found: ${threadId}`);
      const worker = deps.workersStore.getById(thread.scopeId!);
      const project = worker ? deps.projectsStore.getById(worker.projectId) : null;
      if (!worker || !project) throw new Error(`worker or project missing for thread ${threadId}`);
      return {
        kind: "worker",
        worker: { workingDir: worker.worktreePath ?? null },
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
  worker: WorkerRow;
  paneRuntime: TmuxRuntime;
  paneMetadata?: PaneMetadataStore;
  analyzer: Analyzer;
}): Promise<PaneCtx[] | null> {
  let panes: Awaited<ReturnType<TmuxRuntime["listPanes"]>>;
  try {
    panes = await input.paneRuntime.listPanes(input.worker.id);
  } catch (err) {
    if (err instanceof CommandDidNotAnswerError) return null;
    return [];
  }
  return panes.map((pane) => {
    const metadata = input.paneMetadata?.get(pane.id);
    // What the screen heuristics decided; a status they could not decide
    // says less than the pane being live (tmux lists no other kind), so that
    // stands in for it.
    const cached = input.analyzer.getCachedAnalysis(pane.id);
    const analysed = cached && cached.status !== "unknown" ? cached : null;
    return {
      paneId: pane.id,
      ...(metadata?.name ? { name: metadata.name } : {}),
      status: analysed?.status ?? "running",
      summary: analysed?.summary ?? ""
    };
  });
}
