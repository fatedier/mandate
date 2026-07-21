import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { createFeatureWithMaterialization } from "../feature-service.js";
import type { FeaturesStore } from "../features-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";
import type { GitClient } from "../../../platform/git/git.js";
import type { PaneRuntimeRegistry } from "../../../runtime/pane-runtime-registry.js";

const params = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).describe(
    "User-facing name, written the way a person would write it — a short phrase, "
    + "normal capitalisation and spaces. It is what the sidebar and the project "
    + "cards show, and it is the only place a human reads this feature's identity. "
    + "Do NOT slugify it: 'Continue the checkout retry refactor', not "
    + "'continue-checkout-retry-refactor'. The machine-readable form is "
    + "derived from this automatically for the tmux window; the git branch is a "
    + "separate parameter. Neither one needs you to pre-flatten the name."
  ),
  mode: z.enum([
    "new-branch-new-worktree",
    "existing-branch-new-worktree",
    "shared-cwd",
    "existing-branch-existing-worktree"
  ]),
  branch: z.string().optional(),
  baseRef: z.string().optional(),
  worktreePath: z.string().optional()
});

interface Result {
  ok?: true;
  featureId?: string;
  featureName?: string;
  /** URL-safe feature identifier — use as :featureSlug for ui_navigate. */
  featureSlug?: string;
  error?: string;
}

export interface CreateFeatureDeps {
  featuresStore: FeaturesStore;
  projectsStore: ProjectsStore;
  agentStore: AgentStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  paneRuntimes: PaneRuntimeRegistry;
  broadcast: LifecyclePublisher;
}

export function buildCreateFeatureTool(deps: CreateFeatureDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "create_feature",
    description: "Create a new feature inside a project. This creates a tmux window and, for worktree modes, a git worktree. For new-branch-new-worktree, pass baseRef when the user specifies which branch/tag/commit to branch from; otherwise the backend resolves a default base.",
    parameters: params,
    approval: "never",
    handler: async (input) => {
      const r = await createFeatureWithMaterialization(input, {
        features: deps.featuresStore,
        projects: deps.projectsStore,
        agentStore: deps.agentStore,
        tmuxClient: deps.tmuxClient,
        gitClient: deps.gitClient,
        paneRuntimes: deps.paneRuntimes
      });
      if (!r.ok) return { error: r.error };
      deps.broadcast({ type: "featureCreated", data: r.feature });
      return {
        ok: true,
        featureId: r.feature.id,
        featureName: r.feature.name,
        featureSlug: r.feature.tmuxWindowName
      };
    }
  };
}
