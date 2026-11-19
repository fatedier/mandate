import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { WorkersStore } from "../workers-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import { threadDisplayTitle } from "../../agent/manager-threads.js";
import { params } from "./list-workers-schema.js";

interface WorkerSummary {
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
  /** URL-safe worker identifier: the worker's part of a page address. */
  slug: string;
  ownership: "app" | "adopted";
  /** The thread that owns this worker; you direct only your own. */
  ownerThreadId: string | null;
  ownerThreadTitle: string | null;
  yours: boolean;
}

interface Result { workers: WorkerSummary[] }

interface ListWorkersDeps {
  workersStore: WorkersStore;
  projectsStore: ProjectsStore;
  agentStore?: AgentStore;
}

export function buildListWorkersTool(deps: ListWorkersDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "list_workers",
    description: "List active workers across all threads. Each shows the thread that owns it; you direct only your own (yours: true). Pass projectId to scope to one project; omit to list all.",
    parameters: params,
    handler: async ({ projectId }, ctx) => {
      const caller = ctx.threadId;
      const workers = projectId
        ? deps.workersStore.listActiveByProject(projectId)
        : deps.workersStore.listAllActive();
      const projectInfo = (id: string): { name: string; slug: string } => {
        const p = deps.projectsStore.getById(id);
        return {
          name: p?.name ?? "(unknown)",
          slug: p?.tmuxSessionName ?? ""
        };
      };
      return {
        workers: workers.map((worker) => {
          const proj = projectInfo(worker.projectId);
          return {
            id: worker.id,
            projectId: worker.projectId,
            projectName: proj.name,
            projectSlug: proj.slug,
            name: worker.name,
            mode: worker.mode,
            branch: worker.branch ?? null,
            baseRef: worker.baseRef ?? null,
            workingDir: worker.worktreePath ?? null,
            slug: worker.tmuxWindowName,
            ownership: worker.ownership,
            ownerThreadId: worker.ownerThreadId,
            ownerThreadTitle: worker.ownerThreadId && deps.agentStore ? threadDisplayTitle(deps.agentStore, worker.ownerThreadId) : null,
            yours: worker.ownerThreadId === caller
          };
        })
      };
    }
  };
}
