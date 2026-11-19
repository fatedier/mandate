import { create } from "zustand";
import { persist } from "zustand/middleware";
import { storageKeeping } from "@/lib/persist-storage";
import { workerTabFromParam, type WorkerTab } from "@/lib/worker-groups";
import type { ThreadWorkerRefDto } from "@shared/api/agents";
import { canvasTabId, completeOrder, fileTabId, replyTabId, tabAfterClose, withShown, withTabBack } from "@/lib/panel-tabs";
import { useReplyTabsStore } from "./reply-tabs";
import type { FileTarget } from "@/lib/file-link";

interface ThreadPanelState {
  open: boolean;
  tabs: string[];
  active: "workers" | string;
  workerTab: Record<string, WorkerTab>;
  /** An archived worker's details, by its tab: kept with the tab, so its
   *  name and view survive the panel closing and a reload. Absent until the
   *  first. */
  archived?: Record<string, ThreadWorkerRefDto>;
  /** The lines a file's tab points at, by its tab: the same file opened again
   *  moves its tab to the new lines. Absent until the first. */
  fileLines?: Record<string, { line?: number; end?: number; opened?: number }>;
  /** The tabs shown, latest last: closing the one in sight goes back to the
   *  one shown before it. Absent until a tab is shown. */
  recent?: string[];
  /** The row's tabs after Workers in the order the person dragged them
   *  into (the reply tabs among them), in this browser. Absent until the
   *  first drag: the row is in the order opened. */
  order?: string[];
  /** When the person last moved a tab (a drop, a Reopen): the newest of
   *  this browser's windows is the one kept. */
  orderAt?: number;
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
  openWorker(threadId: string, workerId: string, tab?: WorkerTab): void;
  /** A canvas as a tab, at the end unless open already; the panel shows it
   *  (a narrow row turns to it, as opening a worker does). */
  openCanvas(threadId: string, canvasId: string): void;
  /** A file as a tab, as a canvas opens; opened again, its tab moves to the
   *  lines asked for. */
  openFile(threadId: string, target: FileTarget): void;
  /** A reply tab (the server's, not among `tabs`) shown; the panel shows it,
   *  as opening a canvas does. */
  openReply(threadId: string, tabId: string): void;
  /** Any tab but Workers: when it was the open one, the tab shown before it
   *  opens, else its left neighbour (the next one for the first), else
   *  Workers. `shown`: the tabs the row that closed it shows (the phone's
   *  sheet shows no canvas tabs), among which these are found. Read as the
   *  tabs are when it closes. */
  closeTab(threadId: string, tabId: string, shown?: (tabId: string) => boolean, drawn?: readonly string[]): void;
  /** A reply tab in sight is gone (the server's list no longer has it): the
   *  tab shown before it opens, else `before` (the tab before it in the row).
   *  Told late, after another was chosen, it changes nothing. */
  tabGone(threadId: string, tabId: string, before: string, shown?: (tabId: string) => boolean): void;
  setActive(threadId: string, active: "workers" | string): void;
  /** A closed tab (a worker's, a canvas's, a file's) opened again and shown,
   *  back after `after` (the tab it followed; null: it led), a file at its
   *  `lines`; the panel shows it. An archived worker's details are read
   *  again, as for a tab remembered from before a reload. */
  reopenTab(threadId: string, tabId: string, after: string | null, lines?: { line?: number; end?: number }): void;
  /** The row's tabs after Workers, every one of them, in the order the
   *  person put them in (a drop, a Reopen). */
  setTabOrder(threadId: string, order: string[]): void;
  /** The same order kept whole as tabs come and go: not the person's move. */
  keepTabOrder(threadId: string, order: string[]): void;
  setWorkerTab(threadId: string, workerId: string, tab: WorkerTab): void;
  setArchivedRef(threadId: string, tabId: string, ref: ThreadWorkerRefDto): void;
  setOpen(threadId: string, open: boolean): void;
  setMaximized(pane: "panel" | null): void;
  setSheet(sheet: "closed" | "half" | "full"): void;
  setNarrow(narrow: boolean): void;
  setNarrowView(view: "chat" | "panel"): void;
}

export const useWorkerPanelStore = create<WorkerPanelState>()(persist((set, get) => {
  // Every change of the tab in sight is remembered, so that closing it can go back.
  const patch = (threadId: string, fn: (s: ThreadPanelState) => ThreadPanelState) => set((state) => {
    const was = state.byThread[threadId] ?? EMPTY;
    const next = fn(was);
    const tracked = next.active === was.active ? next : { ...next, recent: withShown(withShown(was.recent, was.active), next.active) };
    return { byThread: { ...state.byThread, [threadId]: tracked } };
  });
  /** Whether the thread's row has this tab: Workers, one of `tabs` the row
   *  shows, or a reply tab while the server's list has it. */
  const inRow = (threadId: string, tabs: readonly string[], shown: ((tabId: string) => boolean) | undefined) => (tabId: string) =>
    tabId === "workers"
    || (tabs.includes(tabId) && (!shown || shown(tabId)))
    || (useReplyTabsStore.getState().byThread.get(threadId) ?? []).some((tab) => replyTabId(tab.id) === tabId);
  return {
    byThread: {},
    maximized: null,
    sheet: "closed",
    narrow: false,
    narrowView: "chat",
    get: (threadId) => get().byThread[threadId] ?? EMPTY,
    openWorker: (threadId, workerId, tab) => {
      patch(threadId, (s) => ({
        ...s,
        open: true,
        tabs: s.tabs.includes(workerId) ? s.tabs : [...s.tabs, workerId],
        active: workerId,
        workerTab: tab ? { ...s.workerTab, [workerId]: tab } : s.workerTab
      }));
      set({ narrowView: "panel" });
    },
    openCanvas: (threadId, canvasId) => {
      const id = canvasTabId(canvasId);
      patch(threadId, (s) => ({ ...s, open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id }));
      set({ narrowView: "panel" });
    },
    openFile: (threadId, target) => {
      const id = fileTabId(target.path);
      patch(threadId, (s) => ({
        ...s, open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id,
        fileLines: { ...s.fileLines, [id]: { ...(target.line !== undefined ? { line: target.line } : {}), ...(target.end !== undefined ? { end: target.end } : {}), opened: (s.fileLines?.[id]?.opened ?? 0) + 1 } }
      }));
      set({ narrowView: "panel" });
    },
    openReply: (threadId, tabId) => {
      patch(threadId, (s) => ({ ...s, open: true, active: tabId }));
      set({ narrowView: "panel" });
    },
    closeTab: (threadId, tabId, shown, drawn) => patch(threadId, (s) => {
      // Its neighbours as the row draws them: told by the row, else read from
      // the order the person dragged it into, which lists every tab (the
      // reply tabs among them), else the tabs as opened.
      const row = drawn ?? (s.order ? completeOrder(s.order, s.tabs) : s.tabs);
      const there = inRow(threadId, s.tabs, shown);
      const seen = row.filter((t) => t === tabId || there(t));
      const index = seen.indexOf(tabId);
      const tabs = s.tabs.filter((t) => t !== tabId);
      const rest = seen.filter((t) => t !== tabId);
      const active = s.active !== tabId ? s.active : tabAfterClose(s.recent, tabId, inRow(threadId, tabs, shown), rest[Math.max(0, index - 1)] ?? "workers");
      const archived = { ...s.archived };
      delete archived[tabId];
      const fileLines = { ...s.fileLines };
      delete fileLines[tabId];
      // Out of the order too: opened again later it comes last (Reopen puts
      // it back where it stood).
      return { ...s, tabs, active, archived, fileLines, ...(s.order ? { order: s.order.filter((t) => t !== tabId) } : {}) };
    }),
    tabGone: (threadId, tabId, before, shown) => patch(threadId, (s) => (s.active !== tabId ? s : { ...s, active: tabAfterClose(s.recent, tabId, inRow(threadId, s.tabs, shown), before) })),
    setActive: (threadId, active) => patch(threadId, (s) => ({ ...s, active })),
    reopenTab: (threadId, tabId, after, lines) => {
      patch(threadId, (s) => ({
        ...s, open: true, tabs: withTabBack(s.tabs, tabId, after), active: tabId,
        ...(lines ? { fileLines: { ...s.fileLines, [tabId]: { ...lines, opened: (s.fileLines?.[tabId]?.opened ?? 0) + 1 } } } : {})
      }));
      set({ narrowView: "panel" });
    },
    setTabOrder: (threadId, order) => patch(threadId, (s) => ({ ...s, order, orderAt: Date.now() })),
    keepTabOrder: (threadId, order) => patch(threadId, (s) => ({ ...s, order })),
    setWorkerTab: (threadId, workerId, tab) => patch(threadId, (s) => ({ ...s, workerTab: { ...s.workerTab, [workerId]: tab } })),
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
  // v3: saved tabs before it name workers by ids or fields that no longer
  // exist (feat_ ids, then archived refs' featureId), so they are left behind.
  name: "mandate.worker-panel.v3",
  // Another window of this browser may have moved a thread's tabs since:
  // its newer order stays, whatever this one saves about the rest, and so do
  // the panels it opened that this one never loaded (a panel is never let go).
  storage: storageKeeping<Pick<WorkerPanelState, "byThread">>((saving, saved) => {
    if (!saved?.byThread) return saving;
    const byThread = Object.fromEntries(Object.entries(saving.byThread).map(([threadId, panel]) => {
      const there = saved.byThread[threadId];
      return [threadId, there?.order && (there.orderAt ?? 0) > (panel.orderAt ?? 0) ? { ...panel, order: there.order, orderAt: there.orderAt } : panel];
    }));
    return { ...saving, byThread: { ...saved.byThread, ...byThread } };
  }),
  // Maximize and the narrow row are temporary: not remembered across reloads.
  partialize: (state) => ({ byThread: state.byThread }),
  // A worker's tab remembered under a name the panel no longer has is left
  // behind: the worker opens on its default.
  merge: (persisted, current) => {
    const saved = (persisted as Partial<Pick<WorkerPanelState, "byThread">> | undefined)?.byThread;
    if (!saved || typeof saved !== "object") return current;
    const byThread = Object.fromEntries(Object.entries(saved).map(([threadId, panel]) => {
      // An order saved as anything but a list of tab ids names none.
      const { order, orderAt, ...rest } = panel ?? ({} as ThreadPanelState);
      const ordered = Array.isArray(order) && order.every((id) => typeof id === "string");
      return [threadId, {
        ...rest,
        workerTab: Object.fromEntries(Object.entries(panel?.workerTab ?? {}).filter(([, tab]) => workerTabFromParam(tab as string) !== null)),
        ...(ordered ? { order, ...(typeof orderAt === "number" ? { orderAt } : {}) } : {})
      }];
    }));
    return { ...current, byThread };
  }
}));
