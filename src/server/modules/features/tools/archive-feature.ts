import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { archiveFeatureCascade, type ArchiveFeatureCleanupFailure } from "../feature-service.js";
import type { FeaturesStore } from "../features-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";
import type { GitClient } from "../../../platform/git/git.js";
import type { PaneRuntimeRegistry } from "../../../runtime/pane-runtime-registry.js";

const params = z.object({
  featureId: z.string().min(1),
  killWorktree: z.boolean().optional(),
  removeWorktree: z.boolean().optional(),
  forceRemoveWorktree: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
  forceDeleteBranch: z.boolean().optional()
});

interface Result {
  ok?: true;
  featureId?: string;
  error?: string;
  cleanupFailures?: ArchiveFeatureCleanupFailure[];
}

export interface ArchiveFeatureDeps {
  featuresStore: FeaturesStore;
  projectsStore: ProjectsStore;
  agentStore: AgentStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  paneRuntimes: PaneRuntimeRegistry;
  broadcast: LifecyclePublisher;
  refreshTmux?: () => void;
  beforeFeatureArchive?: (featureId: string) => void;
}

export function buildArchiveFeatureTool(deps: ArchiveFeatureDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "archive_feature",
    description: "Soft-archive a feature, hide it from active work, and release external resources. The feature record, chat, work item, and canvases are kept so restore_feature can recreate the workspace later.",
    parameters: params,
    approval: "never",
    handler: async ({ featureId, killWorktree, removeWorktree, forceRemoveWorktree, deleteBranch, forceDeleteBranch }) => {
      const r = await archiveFeatureCascade(
        {
          id: featureId,
          killWorktree,
          cleanup: { removeWorktree, forceRemoveWorktree, deleteBranch, forceDeleteBranch }
        },
        {
          projects: deps.projectsStore,
          features: deps.featuresStore,
          tmuxClient: deps.tmuxClient,
          gitClient: deps.gitClient,
          agentStore: deps.agentStore,
          paneRuntimes: deps.paneRuntimes,
          broadcast: deps.broadcast,
          refreshTmux: deps.refreshTmux,
          beforeFeatureArchive: deps.beforeFeatureArchive
        }
      );
      if (!r.ok) return { error: r.error, cleanupFailures: r.cleanupFailures };
      deps.broadcast({ type: "featureArchived", data: { id: featureId, projectId: r.feature.projectId } });
      return { ok: true, featureId, cleanupFailures: r.cleanupFailures?.length ? r.cleanupFailures : undefined };
    }
  };
}
