import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { FeaturesStore } from "../features-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import { threadDisplayTitle } from "../../agent/manager-threads.js";

const params = z.object({ projectId: z.string().optional() });

interface FeatureSummary {
  id: string;
  projectId: string;
  projectName: string;
  /** URL-safe project identifier: the project's part of a page address. */
  projectSlug: string;
  name: string;
  mode: string;
  branch: string | null;
  baseRef: string | null;
  workingDir: string | null;
  /** URL-safe feature identifier: the worker's part of a page address. */
  slug: string;
  ownership: "app" | "adopted";
  /** The thread that owns this worker; you direct only your own. */
  ownerThreadId: string | null;
  ownerThreadTitle: string | null;
  yours: boolean;
}

interface Result { features: FeatureSummary[] }

interface ListFeaturesDeps {
  featuresStore: FeaturesStore;
  projectsStore: ProjectsStore;
  agentStore?: AgentStore;
}

export function buildListFeaturesTool(deps: ListFeaturesDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "list_features",
    description: "List active features (workers) across all threads. Each shows the thread that owns it; you direct only your own (yours: true). Pass projectId to scope to one project; omit to list all.",
    parameters: params,
    handler: async ({ projectId }, ctx) => {
      const caller = ctx.threadId;
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
            ownership: f.ownership,
            ownerThreadId: f.ownerThreadId,
            ownerThreadTitle: f.ownerThreadId && deps.agentStore ? threadDisplayTitle(deps.agentStore, f.ownerThreadId) : null,
            yours: f.ownerThreadId === caller
          };
        })
      };
    }
  };
}
