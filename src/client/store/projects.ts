import { create } from "zustand";
import type {
  FeatureStateDto,
  ProjectStateDto,
  FeatureDto
} from "@shared/api-contracts";
import { api } from "@/lib/api-paths";

export type Feature = FeatureStateDto;
export type Project = ProjectStateDto;

interface ProjectsState {
  projects: Project[];
  reordering: boolean;
  pinningFeatureIds: ReadonlySet<string>;
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
  addFeature: (projectId: string, feature: Feature) => void;
  removeFeature: (projectId: string, featureId: string) => void;
  togglePin: (featureId: string) => Promise<void>;
}

function indexById(list: Project[]): Record<string, Project> {
  const result: Record<string, Project> = {};
  for (const p of list) result[p.id] = p;
  return result;
}

function indexBySlug(list: Project[]): Record<string, Project> {
  const result: Record<string, Project> = {};
  for (const p of list) result[p.tmuxSessionName] = p;
  return result;
}

/** Find a feature within a project by its tmuxWindowName slug. tmuxWindowName
 *  is unique within a project (enforced by takenWindowNames at create time). */
export function findFeatureBySlug(project: Project | undefined, slug: string | undefined): Feature | undefined {
  if (!project || !slug) return undefined;
  return project.features.find((f) => f.tmuxWindowName === slug);
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

function updateFeature(projects: Project[], featureId: string, update: (feature: Feature) => Feature): Project[] {
  return projects.map((project) => {
    if (!project.features.some((feature) => feature.id === featureId)) return project;
    return { ...project, features: project.features.map((feature) => feature.id === featureId ? update(feature) : feature) };
  });
}

// An authoritative snapshot supersedes rollback data captured before it.
let snapshotVersion = 0;

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  reordering: false,
  pinningFeatureIds: new Set(),
  byId: {},
  bySlug: {},

  setProjects: (projects) => {
    snapshotVersion++;
    set(reindex(projects));
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

  addFeature: (projectId, feature) => set((state) => reindex(
    state.projects.map((p) =>
      p.id === projectId ? { ...p, features: [...p.features, feature] } : p
    )
  )),

  removeFeature: (projectId, featureId) => set((state) => reindex(
    state.projects.map((p) =>
      p.id === projectId
        ? { ...p, features: p.features.filter((f) => f.id !== featureId) }
        : p
    )
  )),

  togglePin: async (featureId: string): Promise<void> => {
    if (get().pinningFeatureIds.has(featureId)) return;
    // find current feature
    let currentFeature: Feature | null = null;
    for (const p of get().projects) {
      const f = p.features.find((ff) => ff.id === featureId);
      if (f) { currentFeature = f; break; }
    }
    if (!currentFeature || currentFeature.archivedAt) return;
    const version = snapshotVersion;
    const previousPinnedAt = currentFeature.pinnedAt;
    const wasPinned = !!currentFeature.pinnedAt;
    const optimisticPinnedAt = wasPinned ? null : new Date().toISOString();

    // optimistic update
    set((state) => ({
      ...reindex(updateFeature(state.projects, featureId, (feature) => ({ ...feature, pinnedAt: optimisticPinnedAt }))),
      pinningFeatureIds: new Set([...state.pinningFeatureIds, featureId])
    }));

    try {
      const res = await fetch(api.featurePin(featureId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: !wasPinned })
      });
      if (!res.ok) throw new Error(`pin failed: ${res.status}`);
      const body = await res.json() as { feature: FeatureDto };
      // Preserve a newer snapshot, including changes made by another client.
      set((state) => reindex(updateFeature(state.projects, featureId, (feature) =>
        feature.archivedAt || feature.updatedAt > body.feature.updatedAt
          ? feature
          : { ...feature, pinnedAt: body.feature.pinnedAt, updatedAt: body.feature.updatedAt }
      )));
    } catch (e) {
      if (version === snapshotVersion) {
        set((state) => reindex(updateFeature(state.projects, featureId, (feature) =>
          feature.pinnedAt === optimisticPinnedAt
            ? { ...feature, pinnedAt: previousPinnedAt }
            : feature
        )));
      }
      console.error("[projects/togglePin] failed", e);
    } finally {
      set((state) => {
        const pinningFeatureIds = new Set(state.pinningFeatureIds);
        pinningFeatureIds.delete(featureId);
        return { pinningFeatureIds };
      });
    }
  }
}));
