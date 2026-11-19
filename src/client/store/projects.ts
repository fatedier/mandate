import { create } from "zustand";
import type {
  ProjectStateDto,
  WorkerDto
} from "@shared/api-contracts";
import { api } from "@/lib/api-paths";

export type ProjectWorker = WorkerDto;
export type Project = ProjectStateDto;

interface ProjectsState {
  projects: Project[];
  /** True once the server's project list arrived (an empty list counts). */
  loaded: boolean;
  reordering: boolean;
  pinningWorkerIds: ReadonlySet<string>;
  byId: Record<string, Project>;
  /** Lookup by tmuxSessionName — used by URL routing where the project
   *  slug in the path is project.tmuxSessionName instead of the raw id.
   *  tmuxSessionName is unique per active project (enforced by
   *  takenTmuxSessionNames at create time). */
  bySlug: Record<string, Project>;

  setProjects: (projects: Project[]) => void;
  setProjectsState: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (id: string) => void;
  reorderProjects: (projectIds: string[]) => Promise<void>;
  addWorker: (projectId: string, worker: ProjectWorker) => void;
  removeWorker: (projectId: string, workerId: string) => void;
  togglePin: (workerId: string) => Promise<void>;
}

/** A lookup with no inherited keys: an id or slug read from an address can
 *  be any string, `constructor` and `__proto__` too. */
function lookup(): Record<string, Project> {
  return Object.create(null) as Record<string, Project>;
}

function indexById(list: Project[]): Record<string, Project> {
  const result = lookup();
  for (const p of list) result[p.id] = p;
  return result;
}

function indexBySlug(list: Project[]): Record<string, Project> {
  const result = lookup();
  for (const p of list) result[p.tmuxSessionName] = p;
  return result;
}

/** Find a worker within a project by its tmuxWindowName slug. tmuxWindowName
 *  is unique within a project (enforced by takenWindowNames at create time). */
export function findWorkerBySlug(project: Project | undefined, slug: string | undefined): ProjectWorker | undefined {
  if (!project || !slug) return undefined;
  return project.workers.find((w) => w.tmuxWindowName === slug);
}

function reindex(projects: Project[]) {
  return { projects, byId: indexById(projects), bySlug: indexBySlug(projects) };
}

function reorderProjectList(projects: Project[], projectIds: string[]): Project[] | null {
  if (projectIds.length !== projects.length) return null;
  const byId = new Map(projects.map((project) => [project.id, project]));
  if (byId.size !== projects.length) return null;
  const seen = new Set<string>();
  const next: Project[] = [];
  for (const id of projectIds) {
    const project = byId.get(id);
    if (!project || seen.has(id)) return null;
    seen.add(id);
    next.push({ ...project, sortOrder: next.length * 1000 });
  }
  return next;
}

function restoreProjectOrder(current: Project[], previous: Project[]): Project[] {
  const currentById = indexById(current);
  const previousIds = new Set(previous.map((project) => project.id));
  const restored = previous.flatMap((project) => {
    const latest = currentById[project.id];
    return latest ? [{ ...latest, sortOrder: project.sortOrder }] : [];
  });
  let index = 0;
  // Keep newly added projects in place and never restore archived projects.
  return current.map((project) => previousIds.has(project.id) ? restored[index++]! : project);
}

function updateWorker(projects: Project[], workerId: string, update: (worker: ProjectWorker) => ProjectWorker): Project[] {
  return projects.map((project) => {
    if (!project.workers.some((worker) => worker.id === workerId)) return project;
    return { ...project, workers: project.workers.map((worker) => worker.id === workerId ? update(worker) : worker) };
  });
}

// An authoritative snapshot supersedes rollback data captured before it.
let snapshotVersion = 0;

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  loaded: false,
  reordering: false,
  pinningWorkerIds: new Set(),
  byId: lookup(),
  bySlug: lookup(),

  setProjects: (projects) => {
    snapshotVersion++;
    set({ ...reindex(projects), loaded: true });
  },

  setProjectsState: (projects) => get().setProjects(projects),

  addProject: (project) => set((state) => reindex([project, ...state.projects])),

  removeProject: (id) => set((state) => reindex(state.projects.filter((p) => p.id !== id))),

  reorderProjects: async (projectIds: string[]): Promise<void> => {
    if (get().reordering) return;
    const previous = get().projects;
    const next = reorderProjectList(previous, projectIds);
    if (!next) return;
    const version = snapshotVersion;
    set({ ...reindex(next), reordering: true });
    try {
      const res = await fetch(api.projectReorder, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectIds })
      });
      if (!res.ok) throw new Error(`project reorder failed: ${res.status}`);
    } catch (error) {
      if (version === snapshotVersion) {
        set((state) => reindex(restoreProjectOrder(state.projects, previous)));
      }
      console.error("[projects/reorder] failed", error);
    } finally {
      set({ reordering: false });
    }
  },

  addWorker: (projectId, worker) => set((state) => reindex(
    state.projects.map((p) =>
      p.id === projectId ? { ...p, workers: [...p.workers, worker] } : p
    )
  )),

  removeWorker: (projectId, workerId) => set((state) => reindex(
    state.projects.map((p) =>
      p.id === projectId
        ? { ...p, workers: p.workers.filter((w) => w.id !== workerId) }
        : p
    )
  )),

  togglePin: async (workerId: string): Promise<void> => {
    if (get().pinningWorkerIds.has(workerId)) return;
    // find current worker
    let currentWorker: ProjectWorker | null = null;
    for (const p of get().projects) {
      const found = p.workers.find((w) => w.id === workerId);
      if (found) { currentWorker = found; break; }
    }
    if (!currentWorker || currentWorker.archivedAt) return;
    const version = snapshotVersion;
    const previousPinnedAt = currentWorker.pinnedAt;
    const wasPinned = !!currentWorker.pinnedAt;
    const optimisticPinnedAt = wasPinned ? null : new Date().toISOString();

    // optimistic update
    set((state) => ({
      ...reindex(updateWorker(state.projects, workerId, (worker) => ({ ...worker, pinnedAt: optimisticPinnedAt }))),
      pinningWorkerIds: new Set([...state.pinningWorkerIds, workerId])
    }));

    try {
      const res = await fetch(api.workerPin(workerId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: !wasPinned })
      });
      if (!res.ok) throw new Error(`pin failed: ${res.status}`);
      const body = await res.json() as { worker: WorkerDto };
      // Preserve a newer snapshot, including changes made by another client.
      set((state) => reindex(updateWorker(state.projects, workerId, (worker) =>
        worker.archivedAt || worker.updatedAt > body.worker.updatedAt
          ? worker
          : { ...worker, pinnedAt: body.worker.pinnedAt, updatedAt: body.worker.updatedAt }
      )));
    } catch (e) {
      if (version === snapshotVersion) {
        set((state) => reindex(updateWorker(state.projects, workerId, (worker) =>
          worker.pinnedAt === optimisticPinnedAt
            ? { ...worker, pinnedAt: previousPinnedAt }
            : worker
        )));
      }
      console.error("[projects/togglePin] failed", e);
    } finally {
      set((state) => {
        const pinningWorkerIds = new Set(state.pinningWorkerIds);
        pinningWorkerIds.delete(workerId);
        return { pinningWorkerIds };
      });
    }
  }
}));
