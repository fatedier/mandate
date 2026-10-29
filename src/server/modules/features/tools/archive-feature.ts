import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { archiveFeatureCascade, type ArchiveFeatureCleanupFailure } from "../feature-service.js";
import { ownerRefusal } from "../ownership.js";
import type { ArchiveCheckDto } from "../../../../shared/api/features.js";
import type { FeaturesStore } from "../features-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";
import type { GitClient } from "../../../platform/git/git.js";
import type { PaneRuntimeRegistry } from "../../../runtime/pane-runtime-registry.js";

const params = z.object({
  featureId: z.string().min(1),
  removeWorktree: z.boolean().optional(),
  forceRemoveWorktree: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
  forceDeleteBranch: z.boolean().optional(),
  confirmedByUser: z.boolean().optional().describe(
    "Set only after the user said, in this thread, to archive despite the findings the previous call returned."
  )
});

interface Result {
  ok?: true;
  featureId?: string;
  error?: string;
  cleanupFailures?: ArchiveFeatureCleanupFailure[];
  /** What the refusal found: uncommitted files, unmerged commits. */
  check?: ArchiveCheckDto;
}

interface ArchiveFeatureDeps {
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
    description: "Archive a finished worker (feature): hide it from active work and release its tmux window, worktree and branch. The record, chat, plan and reports are kept; restore_feature brings the workspace back. Archive only after the user confirmed the work is done (merged, or they said so). The call refuses when the worktree has uncommitted files or the branch has work not in its base, and returns what it found: ask the user, and pass confirmedByUser only after they said to archive anyway.",
    parameters: params,
    handler: async ({ featureId, removeWorktree, forceRemoveWorktree, deleteBranch, forceDeleteBranch, confirmedByUser }, ctx) => {
      const refusal = ownerRefusal({ featuresStore: deps.featuresStore, agentStore: deps.agentStore }, featureId, ctx.threadId);
      if (refusal) return { error: refusal };
      const r = await archiveFeatureCascade(
        {
          id: featureId,
          cleanup: { removeWorktree, forceRemoveWorktree, deleteBranch, forceDeleteBranch },
          confirmed: confirmedByUser
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
      if (!r.ok) return { error: r.error, cleanupFailures: r.cleanupFailures, ...(r.check ? { check: r.check } : {}) };
      deps.broadcast({ type: "featureArchived", data: { id: featureId, projectId: r.feature.projectId } });
      return { ok: true, featureId, cleanupFailures: r.cleanupFailures?.length ? r.cleanupFailures : undefined };
    }
  };
}
