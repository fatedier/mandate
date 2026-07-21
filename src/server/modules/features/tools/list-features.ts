import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { FeaturesStore } from "../features-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";

const params = z.object({ projectId: z.string().optional() });

interface FeatureSummary {
  id: string;
  projectId: string;
  projectName: string;
  /** URL-safe project identifier — use as :projectSlug for ui_navigate. */
  projectSlug: string;
  name: string;
  mode: string;
  branch: string | null;
  baseRef: string | null;
  workingDir: string | null;
  /** URL-safe feature identifier — use as :featureSlug for ui_navigate. */
  slug: string;
  ownership: "app" | "adopted";
}

interface Result { features: FeatureSummary[] }

export interface ListFeaturesDeps {
  featuresStore: FeaturesStore;
  projectsStore: ProjectsStore;
}

export function buildListFeaturesTool(deps: ListFeaturesDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "list_features",
    description: "List active features. Pass projectId to scope to one project; omit to list all.",
    parameters: params,
    approval: "never",
    handler: async ({ projectId }) => {
      const feats = projectId
        ? deps.featuresStore.listActiveByProject(projectId)
        : deps.featuresStore.listAllActive();
      const projectInfo = (id: string): { name: string; slug: string } => {
        const p = deps.projectsStore.getById(id);
        return {
          name: p?.name ?? "(unknown)",
          slug: p?.tmuxSessionName ?? ""
        };
      };
      return {
        features: feats.map((f) => {
          const proj = projectInfo(f.projectId);
          return {
            id: f.id,
            projectId: f.projectId,
            projectName: proj.name,
            projectSlug: proj.slug,
            name: f.name,
            mode: f.mode,
            branch: f.branch ?? null,
            baseRef: f.baseRef ?? null,
            workingDir: f.worktreePath ?? null,
            slug: f.tmuxWindowName,
            ownership: f.ownership
          };
        })
      };
    }
  };
}
