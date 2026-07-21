import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { archiveProjectCascade } from "../project-service.js";
import type { ProjectsStore } from "../projects-store.js";
import type { FeaturesStore } from "../../features/features-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";

const params = z.object({
  projectId: z.string().min(1),
  killTmux: z.boolean().optional()
});

interface Result {
  ok?: true;
  projectId?: string;
  error?: string;
}

export interface ArchiveProjectDeps {
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  tmuxClient: TmuxClient;
  sessionDataDir?: string;
  broadcast: LifecyclePublisher;
}

export function buildArchiveProjectTool(deps: ArchiveProjectDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "archive_project",
    description: "Archive a project and cascade-archive all its features. Optionally kill the tmux session.",
    parameters: params,
    approval: "never",
    handler: async ({ projectId, killTmux }) => {
      const r = await archiveProjectCascade(
        { id: projectId, killTmux: killTmux ?? false },
        {
          projects: deps.projectsStore,
          features: deps.featuresStore,
          tmuxClient: deps.tmuxClient,
          sessionDataDir: deps.sessionDataDir
        }
      );
      if (!r.ok) return { error: r.error };
      deps.broadcast({ type: "projectArchived", data: { id: projectId } });
      return { ok: true, projectId };
    }
  };
}
