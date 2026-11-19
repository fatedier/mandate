import type { ProjectsStore } from "../projects/projects-store.js";
import type { WorkersStore } from "../workers/workers-store.js";

/** Where threads' work ran: the projects of their workers, active or
 *  archived, each once, in the order the workers were made. A task's
 *  automatic labels are these. */
export function workRanIn(deps: {
  workersStore: Pick<WorkersStore, "listActiveOwnedBy" | "listArchivedOwnedBy">;
  projectsStore: Pick<ProjectsStore, "getById">;
}): (threadIds: readonly string[]) => string[] {
  return (threadIds) => {
    const workers = threadIds
      .flatMap((id) => [...deps.workersStore.listActiveOwnedBy(id), ...deps.workersStore.listArchivedOwnedBy(id)])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const names: string[] = [];
    const seen = new Set<string>();
    for (const worker of workers) {
      if (seen.has(worker.projectId)) continue;
      seen.add(worker.projectId);
      const name = deps.projectsStore.getById(worker.projectId)?.name;
      if (name) names.push(name);
    }
    return names;
  };
}

/** The projects of the workers a thread owns or owned, each once: whose
 *  learned skills a manager's list shows. */
export function projectIdsOfThread(deps: {
  workersStore: Pick<WorkersStore, "listActiveOwnedBy" | "listArchivedOwnedBy">;
}): (threadId: string) => string[] {
  return (threadId) => {
    const ids = new Set<string>();
    for (const worker of [...deps.workersStore.listActiveOwnedBy(threadId), ...deps.workersStore.listArchivedOwnedBy(threadId)]) ids.add(worker.projectId);
    return [...ids];
  };
}
