import type { AgentStore } from "../../modules/agent/agent-store.js";
import type { ProjectsStore } from "../../modules/projects/projects-store.js";
import type { FeaturesStore } from "../../modules/features/features-store.js";
import type { Analyzer } from "../../modules/analysis/analyzer.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { FeatureRow } from "../../modules/features/features-store.js";
import type { ProjectRow } from "../../modules/projects/projects-store.js";
import type { PaneRuntime } from "../pane-runtime.js";
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
import type { Config } from "../../config.js";

const SKILLS_REFRESH_THROTTLE_MS = 5 * 60 * 1000;
const RUNTIME_MEMORY_ENTRY_LIMIT = 3;
const RUNTIME_MEMORY_ENTRY_MAX_CHARS = 500;

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
  toolPacks?: ToolPack[];
}

/** Build the worker-scope runtime: the per-feature worker that runs in a
 *  single feature window, has bash/file/pane tools, and gets ctx augmented
 *  with the feature/project/tmuxClient/analyzer the pane tools need. */
export function buildWorkerScope(deps: WorkerScopeDeps): ScopeRuntime {
  const registry = new ToolRegistry();
  registerToolPacks(registry, "worker", deps.toolPacks ?? []);

  const dispatcher = new ToolDispatcher(registry);

  const wrappedDispatcher: WrappedDispatcher = {
    registry: { tools: registry.tools },
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
        availableSkillsSection: deps.skillRegistry.renderManifest("worker")
      });
    },

    async buildRuntimeContext(threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || !thread.scopeId) return null;
      const lineageThreadId = deps.agentStore.lineageThreadId(threadId);
      const feature = deps.featuresStore.getById(thread.scopeId);
      if (!feature) return null;
      const project = deps.projectsStore.getById(feature.projectId);
      if (!project) return null;
      const memorySection = deps.memory
        ? await deps.memory.buildPromptSection({
            projectId: project.id,
            featureId: feature.id,
            threadId: lineageThreadId
          }, {
            limit: RUNTIME_MEMORY_ENTRY_LIMIT,
            maxEntryChars: RUNTIME_MEMORY_ENTRY_MAX_CHARS
          })
        : "";
      const tasksSection = renderTaskQueueSection(deps.agentStore.listTasksForThread(lineageThreadId, {
        limit: 8
      }));
      const panes = await buildPaneContext({
        project,
        feature,
        paneRuntime: deps.paneRuntimes.forProject(project.id),
        paneMetadata: deps.paneMetadata,
        analyzer: deps.analyzer
      });
      return buildWorkerRuntimeContext({
        panes,
        tasksSection,
        memorySection
      });
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
    toolDefinitions: registry.definitions
  };
}

async function buildPaneContext(input: {
  project: ProjectRow;
  feature: FeatureRow;
  paneRuntime: PaneRuntime;
  paneMetadata?: PaneMetadataStore;
  analyzer: Analyzer;
}): Promise<PaneCtx[]> {
  let panes: Awaited<ReturnType<PaneRuntime["listPanes"]>>;
  try {
    panes = await input.paneRuntime.listPanes(input.feature.id);
  } catch {
    return [];
  }
  return panes.map((pane) => {
    const metadata = input.paneMetadata?.get(pane.id);
    const cached = (input.analyzer as Analyzer & {
      getCachedAnalysis?: (paneId: string) => { status?: string; summary?: string } | null;
    }).getCachedAnalysis?.(pane.id);
    return {
      paneId: pane.id,
      ...(metadata?.name ? { name: metadata.name } : {}),
      ...(metadata?.description ? { description: metadata.description } : {}),
      command: pane.command.join(" ") || "(shell)",
      cwd: pane.cwd,
      status: cached?.status ?? pane.status,
      summary: cached?.summary ?? ""
    };
  });
}

function renderTaskQueueSection(
  tasks: ReturnType<AgentStore["listTasksForThread"]>
): string {
  if (tasks.length === 0) {
    return "No open structured tasks.";
  }
  return tasks.map((task) => {
    const note = task.lastNote ? ` — note: ${limitPromptText(task.lastNote, 500)}` : "";
    return `- ${task.id} [${task.status}] ${limitPromptText(task.title, 220)} (${task.channel}, priority ${task.priority})${note}`;
  }).join("\n");
}

function limitPromptText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
