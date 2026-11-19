import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ThreadFilters, ThreadsTab } from "@/routes/threads/thread-list";

export const THREADS_LIST_STORAGE_KEY = "mandate.threads-list.v1";

interface ThreadsListState {
  /** The tab the Threads page shows; kept in this browser. */
  tab: ThreadsTab;
  /** The ticked filters; kept in this browser until cleared. */
  filters: ThreadFilters;
  setTab(tab: ThreadsTab): void;
  toggleLabel(name: string): void;
  toggleProject(name: string): void;
  /** Tick exactly these (Select all, or none). */
  setLabels(names: string[]): void;
  setProjects(names: string[]): void;
  clearFilters(): void;
}

export const THREADS_LIST_DEFAULTS = { tab: "active" as ThreadsTab, filters: { labels: [], projects: [] } as ThreadFilters };

/** What the Threads page remembers between visits: its tab and its filters. */
export const useThreadsListStore = create<ThreadsListState>()(persist((set) => ({
  ...THREADS_LIST_DEFAULTS,
  setTab: (tab) => set({ tab }),
  toggleLabel: (name) => set((s) => {
    const on = s.filters.labels.some((l) => l.toLowerCase() === name.toLowerCase());
    return { filters: { ...s.filters, labels: on ? s.filters.labels.filter((l) => l.toLowerCase() !== name.toLowerCase()) : [...s.filters.labels, name] } };
  }),
  toggleProject: (name) => set((s) => ({
    filters: { ...s.filters, projects: s.filters.projects.includes(name) ? s.filters.projects.filter((p) => p !== name) : [...s.filters.projects, name] }
  })),
  setLabels: (labels) => set((s) => ({ filters: { ...s.filters, labels } })),
  setProjects: (projects) => set((s) => ({ filters: { ...s.filters, projects } })),
  clearFilters: () => set({ filters: { labels: [], projects: [] } })
}), {
  name: THREADS_LIST_STORAGE_KEY,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ tab: state.tab, filters: state.filters })
}));
