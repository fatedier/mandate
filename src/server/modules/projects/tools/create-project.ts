import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { createProjectWithMaterialization } from "../project-service.js";
import type { ProjectsStore } from "../projects-store.js";
import type { FeaturesStore } from "../../features/features-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";
import type { GitClient } from "../../../platform/git/git.js";

const params = z.object({
  name: z.string().min(1),
  workingDir: z.string().min(1)
});

interface Result {
  ok?: true;
  projectId?: string;
  projectName?: string;
  /** URL-safe project identifier — use as :projectSlug for ui_navigate. */
  projectSlug?: string;
  error?: string;
}

export interface CreateProjectDeps {
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  sessionDataDir?: string;
  broadcast: LifecyclePublisher;
}

export function buildCreateProjectTool(deps: CreateProjectDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "create_project",
    description:
      "Create a new local project — registers it in the DB and creates a tmux session for its windows.",
    parameters: params,
    approval: "never",
    handler: async ({ name, workingDir }) => {
      const r = await createProjectWithMaterialization(
        { name, workingDir },
        {
          projects: deps.projectsStore,
          features: deps.featuresStore,
          tmuxClient: deps.tmuxClient,
          gitClient: deps.gitClient,
          sessionDataDir: deps.sessionDataDir
        }
      );
      if (!r.ok) return { error: r.error };
      deps.broadcast({ type: "projectCreated", data: r.project });
      return {
        ok: true,
        projectId: r.project.id,
        projectName: r.project.name,
        projectSlug: r.project.tmuxSessionName
      };
    }
  };
}
