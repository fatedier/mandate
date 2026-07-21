import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { featureRowToDto, restoreFeatureMaterialization } from "../feature-service.js";
import type { FeaturesStore } from "../features-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";
import type { GitClient } from "../../../platform/git/git.js";
import type { PaneRuntimeRegistry } from "../../../runtime/pane-runtime-registry.js";

const params = z.object({
  featureId: z.string().min(1),
  mode: z.enum([
    "new-branch-new-worktree",
    "existing-branch-new-worktree",
    "shared-cwd",
    "existing-branch-existing-worktree"
  ]).optional(),
  branch: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  tmuxWindowName: z.string().min(1).optional()
});

interface Result {
  ok?: true;
  featureId?: string;
  error?: string;
}

export interface RestoreFeatureDeps {
  featuresStore: FeaturesStore;
  projectsStore: ProjectsStore;
  agentStore: AgentStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  paneRuntimes: PaneRuntimeRegistry;
  broadcast: LifecyclePublisher;
  refreshTmux?: () => void;
}

export function buildRestoreFeatureTool(deps: RestoreFeatureDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "restore_feature",
    description: "Restore an archived feature by recreating its tmux window and, when needed, its worktree/branch. Pass branch/worktreePath/tmuxWindowName to avoid restore conflicts.",
    parameters: params,
    approval: "never",
    handler: async ({ featureId, mode, branch, baseRef, worktreePath, tmuxWindowName }) => {
      const r = await restoreFeatureMaterialization(
        { id: featureId, mode, branch, baseRef, worktreePath, tmuxWindowName },
        {
          projects: deps.projectsStore,
          features: deps.featuresStore,
          tmuxClient: deps.tmuxClient,
          gitClient: deps.gitClient,
          agentStore: deps.agentStore,
          paneRuntimes: deps.paneRuntimes,
          broadcast: deps.broadcast,
          refreshTmux: deps.refreshTmux
        }
      );
      if (!r.ok) return { error: r.error };
      deps.broadcast({ type: "featureRestored", data: featureRowToDto(r.feature) });
      return { ok: true, featureId };
    }
  };
}
