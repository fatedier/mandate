import type { AgentStore } from "../agent/agent-store.js";
import { buildArchiveFeatureTool } from "./tools/archive-feature.js";
import { buildCreateFeatureTool } from "./tools/create-feature.js";
import { buildGetFeatureStatusTool } from "./tools/get-feature-status.js";
import { buildListFeaturesTool } from "./tools/list-features.js";
import { buildReadFeatureThreadTool } from "./tools/read-feature-thread.js";
import { buildRestoreFeatureTool } from "./tools/restore-feature.js";
import type { FeaturesStore } from "./features-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { MemoryManager } from "../memory/manager.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { PaneRuntimeRegistry } from "../../runtime/pane-runtime-registry.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { TmuxSnapshot } from "../../platform/tmux/tmux-types.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { GitClient } from "../../platform/git/git.js";
import type { TaskListItem } from "../../runtime/task-list.js";

export function buildFeatureCatalogToolPacks(input: {
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  getSnapshot: () => TmuxSnapshot | null;
  /** A conversation's queued and running tasks: get_feature_status names its worker's. */
  tasksOfThread?: (threadId: string) => TaskListItem[];
}): ToolPack[] {
  return [
    toolPack("features.catalog", ["manager"], [
      buildListFeaturesTool({
        featuresStore: input.featuresStore,
        projectsStore: input.projectsStore,
        agentStore: input.agentStore
      }),
      buildGetFeatureStatusTool({
        featuresStore: input.featuresStore,
        projectsStore: input.projectsStore,
        getSnapshot: input.getSnapshot,
        agentStore: input.agentStore,
        ...(input.tasksOfThread ? { tasksOfThread: input.tasksOfThread } : {})
      }),
      buildReadFeatureThreadTool({
        agentStore: input.agentStore,
        featuresStore: input.featuresStore
      })
    ])
  ];
}

export function buildFeatureLifecycleToolPacks(input: {
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  paneRuntimes: PaneRuntimeRegistry;
  publishLifecycle: LifecyclePublisher;
  beforeFeatureArchive?: (featureId: string) => void;
  memory?: MemoryManager | null;
}): ToolPack[] {
  return [
    toolPack("features.lifecycle", ["manager"], [
      buildCreateFeatureTool({
        featuresStore: input.featuresStore,
        projectsStore: input.projectsStore,
        agentStore: input.agentStore,
        tmuxClient: input.tmuxClient,
        gitClient: input.gitClient,
        paneRuntimes: input.paneRuntimes,
        broadcast: input.publishLifecycle,
        projectMemoryHint: (projectId) => {
          const project = input.projectsStore.getById(projectId);
          return project && input.memory?.getBrief("project", projectId)
            ? `${project.name} has memory: read its brief with memory_read({ target: "project", project: "${project.name}" }) before directing the worker.`
            : null;
        }
      }),
      buildArchiveFeatureTool({
        featuresStore: input.featuresStore,
        projectsStore: input.projectsStore,
        agentStore: input.agentStore,
        tmuxClient: input.tmuxClient,
        gitClient: input.gitClient,
        paneRuntimes: input.paneRuntimes,
        broadcast: input.publishLifecycle,
        beforeFeatureArchive: input.beforeFeatureArchive
      }),
      buildRestoreFeatureTool({
        featuresStore: input.featuresStore,
        projectsStore: input.projectsStore,
        agentStore: input.agentStore,
        tmuxClient: input.tmuxClient,
        gitClient: input.gitClient,
        paneRuntimes: input.paneRuntimes,
        broadcast: input.publishLifecycle
      })
    ])
  ];
}
