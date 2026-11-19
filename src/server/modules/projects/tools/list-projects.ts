import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { ProjectsStore } from "../projects-store.js";
import type { WorkersStore } from "../../workers/workers-store.js";
import { params } from "./list-projects-schema.js";

interface ProjectSummary {
  id: string;
  name: string;
  /** URL-safe identifier: the project's part of a page address. */
  slug: string;
  workingDir: string;
  isGit: boolean;
  gitRemote: string | null;
  ownership: "app" | "adopted";
  workerCount: number;
}

interface Result { projects: ProjectSummary[] }

interface ListProjectsDeps {
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
}

export function buildListProjectsTool(deps: ListProjectsDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "list_projects",
    description: "List all active projects in this Mandate instance, with worker counts.",
    parameters: params,
    handler: async () => {
      const projects = deps.projectsStore.listActive();
      const out = projects.map((p) => {
        const workers = deps.workersStore.listActiveByProject(p.id);
        return {
          id: p.id, name: p.name, slug: p.tmuxSessionName,
          workingDir: p.workingDir,
          isGit: p.isGit, gitRemote: p.gitRemote,
          ownership: p.ownership,
          workerCount: workers.length
        };
      });
      return { projects: out };
    }
  };
}
