import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { WorkerTab } from "@/lib/worker-groups";
import type { ThreadWorkerRefDto } from "@shared/api/agents";
import { canvasTabId } from "@/lib/panel-tabs";

interface ThreadPanelState {
  open: boolean;
  tabs: string[];
  active: "workers" | string;
  workerTab: Record<string, WorkerTab>;
  /** An archived worker's details, by its tab: kept with the tab, so its
   *  name and view survive the panel closing and a reload. Absent in state
   *  saved before it existed. */
  archived?: Record<string, ThreadWorkerRefDto>;
}

const EMPTY: ThreadPanelState = { open: true, tabs: [], active: "workers", workerTab: {} };

interface WorkerPanelState {
  byThread: Record<string, ThreadPanelState>;
  /** The panel taking the thread's whole row. The chat has no maximize of
   *  its own: hiding the panel gives it the row. */
  maximized: "panel" | null;
  /** The phone's panel: a sheet, closed, at half or at full height. Like
   *  maximize, not remembered across reloads. */
  sheet: "closed" | "half" | "full";
  /** The thread's row is too narrow for both sides (SPLIT_ROW_MIN_WIDTH):
   *  it shows `narrowView` alone. Measured by the row, not remembered. */
  narrow: boolean;
  /** The side a narrow row shows. Opening a worker turns it to the panel, so
   *  the tab just opened is in sight; a row that narrows starts on the side
   *  that had the row. Turning it to the chat clears `maximized`. */
  narrowView: "chat" | "panel";
  get(threadId: string): ThreadPanelState;
  openWorker(threadId: string, featureId: string, tab?: WorkerTab): void;
  /** A canvas as a tab, at the end unless open already; the panel shows it
   *  (a narrow row turns to it, as opening a worker does). */
  openCanvas(threadId: string, canvasId: string): void;
  /** Any tab but Workers: when it was the open one, its left neighbour opens
   *  (the next one for the first), else Workers. `shown`: the tabs the row
   *  that closed it shows (the phone's sheet shows no canvas tabs), among
   *  which the neighbour is found. Read as the tabs are when it closes. */
  closeTab(threadId: string, tabId: string, shown?: (tabId: string) => boolean): void;
  setActive(threadId: string, active: "workers" | string): void;
  setWorkerTab(threadId: string, featureId: string, tab: WorkerTab): void;
  setArchivedRef(threadId: string, tabId: string, ref: ThreadWorkerRefDto): void;
  setOpen(threadId: string, open: boolean): void;
  setMaximized(pane: "panel" | null): void;
  setSheet(sheet: "closed" | "half" | "full"): void;
  setNarrow(narrow: boolean): void;
  setNarrowView(view: "chat" | "panel"): void;
}

export const useWorkerPanelStore = create<WorkerPanelState>()(persist((set, get) => {
  const patch = (threadId: string, fn: (s: ThreadPanelState) => ThreadPanelState) =>
    set((state) => ({ byThread: { ...state.byThread, [threadId]: fn(state.byThread[threadId] ?? EMPTY) } }));
  return {
    byThread: {},
    maximized: null,
    sheet: "closed",
    narrow: false,
    narrowView: "chat",
    get: (threadId) => get().byThread[threadId] ?? EMPTY,
    openWorker: (threadId, featureId, tab) => {
      patch(threadId, (s) => ({
        ...s,
        open: true,
        tabs: s.tabs.includes(featureId) ? s.tabs : [...s.tabs, featureId],
        active: featureId,
        workerTab: tab ? { ...s.workerTab, [featureId]: tab } : s.workerTab
      }));
      set({ narrowView: "panel" });
    },
    openCanvas: (threadId, canvasId) => {
      const id = canvasTabId(canvasId);
      patch(threadId, (s) => ({ ...s, open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id }));
      set({ narrowView: "panel" });
    },
    closeTab: (threadId, tabId, shown) => patch(threadId, (s) => {
      const seen = shown ? s.tabs.filter((t) => t === tabId || shown(t)) : s.tabs;
      const index = seen.indexOf(tabId);
      const tabs = s.tabs.filter((t) => t !== tabId);
      const rest = seen.filter((t) => t !== tabId);
      const active = s.active !== tabId ? s.active : (rest[Math.max(0, index - 1)] ?? "workers");
      const archived = { ...s.archived };
      delete archived[tabId];
      return { ...s, tabs, active, archived };
    }),
    setActive: (threadId, active) => patch(threadId, (s) => ({ ...s, active })),
    setWorkerTab: (threadId, featureId, tab) => patch(threadId, (s) => ({ ...s, workerTab: { ...s.workerTab, [featureId]: tab } })),
    setArchivedRef: (threadId, tabId, ref) => patch(threadId, (s) => ({ ...s, archived: { ...s.archived, [tabId]: ref } })),
    setOpen: (threadId, open) => patch(threadId, (s) => ({ ...s, open })),
    setMaximized: (maximized) => set({ maximized }),
    setSheet: (sheet) => set({ sheet }),
    setNarrow: (narrow) => set({ narrow }),
    // Back to the chat, the panel no longer has the row in any width: a wider
    // row shows both sides, not a maximize left over from before it narrowed.
    setNarrowView: (narrowView) => set(narrowView === "chat" ? { narrowView, maximized: null } : { narrowView })
  };
}, {
  name: "mandate.worker-panel.v1",
  storage: createJSONStorage(() => localStorage),
  // Maximize and the narrow row are temporary: not remembered across reloads.
  partialize: (state) => ({ byThread: state.byThread })
}));
