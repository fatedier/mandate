import { create } from "zustand";
import { AGENT_PAGE_FIRST } from "@shared/api/agent-page";
import { persist } from "zustand/middleware";
import { storageKeeping } from "@/lib/persist-storage";
import { clampRatio } from "./ui";
import { canvasIdOfTab, canvasTabId, fileTabId, filePathOfTab, NOTES_TAB, CALENDAR_TAB, terminalOfTab, terminalTabId, replyIdOfTab, replyTabId, tabAfterClose, taskIdOfTab, taskTabId, TASKS_TAB, threadIdOfTab, threadTabId, withShown, withTabBack } from "@/lib/panel-tabs";
import { useReplyTabsStore } from "./reply-tabs";
import { useThreadTabsStore } from "./thread-tabs";
import type { FileTarget } from "@/lib/file-link";
import type { TranscriptPlace } from "@/routes/window/chat/useTranscriptViewport";

/** What the Tasks tab's board searches for, and whether it shows cancelled tasks. */
export interface TasksView { query: string; showCancelled: boolean }
const TASKS_VIEW_START: TasksView = { query: "", showCancelled: false };

interface AgentPageUiState {
  /** The page is shown beside the chat. */
  open: boolean;
  /** The page has the whole row. */
  maximized: boolean;
  /** The page's share of the row. */
  ratio: number;
  /** The row is narrow: one side at a time (not kept). */
  narrow: boolean;
  /** In a narrow row, the side in sight (not kept). */
  narrowView: "chat" | "side";
  /** The canvases, files and tasks open as tabs after Page, in the order
   *  opened, and the Tasks tab. */
  tabs: string[];
  /** The tab in sight: "page", "history", or one of `tabs`. */
  active: "page" | string;
  /** The row's tabs after Page in the order the person dragged them into
   *  (History, Tasks, threads and replies among them), in this browser.
   *  Absent until the first drag: each kind keeps its place. */
  order?: string[];
  /** When the person last moved a tab (a drop, a Reopen): the newest of
   *  this browser's windows is the one kept. */
  orderAt?: number;
  /** When the server made each thread tab, as last heard: one heard again
   *  with another time (closed and opened elsewhere while this browser was
   *  shut) is a new tab. */
  threadSeen?: Record<string, string>;
  /** The row's tabs after Page, every one of them, in the order the person
   *  put them in (a drop, a Reopen). */
  setTabOrder(order: string[]): void;
  /** The same order kept whole as tabs come and go: not the person's move. */
  keepTabOrder(order: string[]): void;
  /** The tabs shown, latest last (not kept): closing the one in sight goes
   *  back to the one shown before it. */
  recent: string[];
  /** The personal agent's conversation open as a tab beside it (not kept). */
  history: boolean;
  /** Where History was read up to: it opens there again (null: at the end). */
  historyPlace: TranscriptPlace | null;
  /** Counts each opening at a place: the view starts over there. */
  historyOpened: number;
  /** History shown; at `place` when given (Read beside), else where it was. */
  openHistory(place?: TranscriptPlace | null): void;
  /** `shown`, here and in the other closes: the tabs the row shows, when it
   *  shows only some (a phone's has no canvas or file tabs). */
  closeHistory(shown?: (tabId: string) => boolean, before?: string): void;
  setHistoryPlace(place: TranscriptPlace | null): void;
  setOpen(open: boolean): void;
  setMaximized(maximized: boolean): void;
  setRatio(ratio: number): void;
  setNarrow(narrow: boolean): void;
  setNarrowView(view: "chat" | "side"): void;
  /** A canvas as a tab, at the end unless open already; the side shows it
   *  (a narrow row turns to it). */
  openCanvas(canvasId: string): void;
  /** A file as a tab after the canvases', as a canvas opens; opened again, its
   *  tab moves to the lines asked for. */
  openFile(target: FileTarget): void;
  /** The lines each file's tab points at, by its tab. */
  fileLines: Record<string, { line?: number; end?: number; opened?: number }>;
  /** A reply tab (the server's, not among `tabs`) shown; the side shows it,
   *  as opening a canvas does. */
  openReply(tabId: string): void;
  /** A thread's tab (the server's, not among `tabs`) shown. Asked for from
   *  anywhere (the sidebar, a thread's page), so a narrow row turns to the
   *  side whether or not it is narrow yet. */
  openThread(threadId: string): void;
  /** When it was the one in sight, the tab shown before it opens, else
   *  `before` (the tab before it in the row), else its left neighbour among
   *  `tabs` (the next one for the first), else Page. */
  closeTab(tabId: string, before?: string, shown?: (tabId: string) => boolean): void;
  /** The server's tab in sight (a reply's, a thread's) is gone: the tab shown
   *  before it opens, else `before`. Told late, after another was chosen, it
   *  changes nothing. */
  tabGone(tabId: string, before: string, shown?: (tabId: string) => boolean): void;
  setActive(tabId: "page" | string): void;
  /** A closed canvas, file, task or Tasks tab opened again and shown, back after
   *  `after` (the tab it followed among `tabs`; null: it led them); a file
   *  at its `lines`. */
  reopenTab(tabId: string, after: string | null, lines?: { line?: number; end?: number }): void;
  /** The Tasks tab (the board) shown, opened first when it is not. */
  openTasks(): void;
  /** The Notes tab (the sticky notes' wall) shown, opened after Tasks (or first) when it is not. */
  openNotes(): void;
  /** The calendar's tab, after Notes (or Tasks), else first; chosen. */
  openCalendar(): void;
  /** The Tasks tab's board as it was left (not kept across reloads): the
   *  board is drawn only while its tab is in sight, and a task opened from
   *  it shows another tab. It starts over when the Tasks tab is closed. */
  tasksView: TasksView;
  setTasksView(change: Partial<TasksView>): void;
  /** A task in a tab of its own, at the end unless open already. Asked for
   *  from anywhere (a chip on a thread's page, a link), so a narrow row
   *  turns to the side whether or not it is narrow yet. */
  openTask(taskId: string): void;
  /** A pane's terminal as a tab: once, at the end, shown. */
  openTerminal(paneId: string, pid: number): void;
  /** The page of the page's folder in sight, by its path there (the first
   *  page when the version shown has none there). */
  pagePath: string;
  setPagePath(path: string): void;
}

/** How Personal agent's page sits beside its chat. Open, full screen and its
 *  share of the row are remembered; which side a narrow row shows is not. */
export const useAgentPageUi = create<AgentPageUiState>()(
  persist(
    (setState) => {
      // Every change of the tab in sight is remembered, so that closing it can go back.
      const set = (change: Partial<AgentPageUiState> | ((s: AgentPageUiState) => Partial<AgentPageUiState>)) => setState((s) => {
        const next = typeof change === "function" ? change(s) : change;
        return next.active === undefined || next.active === s.active ? next : { ...next, recent: withShown(withShown(s.recent, s.active), next.active) };
      });
      return {
      open: true,
      maximized: false,
      ratio: 0.5,
      narrow: false,
      narrowView: "chat",
      setOpen: (open) => set({ open }),
      setMaximized: (maximized) => set({ maximized }),
      setRatio: (ratio) => set({ ratio: clampRatio(ratio) }),
      setNarrow: (narrow) => set({ narrow }),
      setNarrowView: (narrowView) => set({ narrowView }),
      tabs: [],
      active: "page",
      recent: [],
      pagePath: AGENT_PAGE_FIRST,
      setPagePath: (pagePath) => set({ pagePath }),
      openCanvas: (canvasId) => {
        const id = canvasTabId(canvasId);
        set((s) => ({ open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id, ...(s.narrow ? { narrowView: "side" as const } : {}) }));
      },
      fileLines: {},
      openFile: (target) => {
        const id = fileTabId(target.path);
        set((s) => ({
          open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id,
          fileLines: { ...s.fileLines, [id]: { ...(target.line !== undefined ? { line: target.line } : {}), ...(target.end !== undefined ? { end: target.end } : {}), opened: (s.fileLines[id]?.opened ?? 0) + 1 } },
          ...(s.narrow ? { narrowView: "side" as const } : {})
        }));
      },
      openReply: (tabId) => set((s) => ({ open: true, active: tabId, ...(s.narrow ? { narrowView: "side" as const } : {}) })),
      openThread: (threadId) => set({ open: true, active: threadTabId(threadId), narrowView: "side" }),
      closeTab: (tabId, before, shown) => set((s) => {
        const index = s.tabs.indexOf(tabId);
        const tabs = s.tabs.filter((t) => t !== tabId);
        const fileLines = { ...s.fileLines };
        delete fileLines[tabId];
        // Its left neighbour as the row draws it: told by the row, else read
        // from the order the person dragged it into, which lists every tab.
        const ordered = s.order?.filter((t) => t === tabId || inRow({ ...s, tabs }, t, shown));
        const at = ordered?.indexOf(tabId) ?? -1;
        const fromOrder = ordered ? (at > 0 ? ordered[at - 1] : "page") : undefined;
        const left = before ?? fromOrder ?? tabs[Math.max(0, index - 1)] ?? "page";
        return {
          tabs, fileLines,
          // Out of the order too: opened again later it comes last (Reopen
          // puts it back where it stood).
          ...(s.order ? { order: s.order.filter((t) => t !== tabId) } : {}),
          ...(tabId === TASKS_TAB ? { tasksView: TASKS_VIEW_START } : {}),
          active: s.active !== tabId ? s.active : tabAfterClose(s.recent, tabId, (t) => inRow({ ...s, tabs }, t, shown), left)
        };
      }),
      tabGone: (tabId, before, shown) => set((s) => (s.active !== tabId ? {} : { active: tabAfterClose(s.recent, tabId, (t) => inRow(s, t, shown), before) })),
      setActive: (active) => set({ active }),
      setTabOrder: (order) => set({ order, orderAt: Date.now() }),
      keepTabOrder: (order) => set({ order }),
      reopenTab: (tabId, after, lines) => set((s) => ({
        open: true,
        tabs: withTabBack(s.tabs, tabId, after, [TASKS_TAB, NOTES_TAB, CALENDAR_TAB]),
        active: tabId,
        ...(lines ? { fileLines: { ...s.fileLines, [tabId]: { ...lines, opened: (s.fileLines[tabId]?.opened ?? 0) + 1 } } } : {}),
        ...(s.narrow ? { narrowView: "side" as const } : {})
      })),
      openTasks: () => set((s) => ({
        open: true,
        tabs: s.tabs.includes(TASKS_TAB) ? s.tabs : [TASKS_TAB, ...s.tabs],
        active: TASKS_TAB,
        // As a thread tab: a narrow row turns to the side, narrow yet or not.
        narrowView: "side" as const
      })),
      openNotes: () => set((s) => ({
        open: true,
        tabs: s.tabs.includes(NOTES_TAB) ? s.tabs : s.tabs.includes(TASKS_TAB)
          ? [...s.tabs.slice(0, s.tabs.indexOf(TASKS_TAB) + 1), NOTES_TAB, ...s.tabs.slice(s.tabs.indexOf(TASKS_TAB) + 1)]
          : [NOTES_TAB, ...s.tabs],
        active: NOTES_TAB,
        narrowView: "side" as const
      })),
      openCalendar: () => set((s) => {
        if (s.tabs.includes(CALENDAR_TAB)) return { open: true, active: CALENDAR_TAB, narrowView: "side" as const };
        const lead = [NOTES_TAB, TASKS_TAB].find((tab) => s.tabs.includes(tab));
        const at = lead === undefined ? 0 : s.tabs.indexOf(lead) + 1;
        return { open: true, tabs: [...s.tabs.slice(0, at), CALENDAR_TAB, ...s.tabs.slice(at)], active: CALENDAR_TAB, narrowView: "side" as const };
      }),
      tasksView: TASKS_VIEW_START,
      setTasksView: (change) => set((s) => ({ tasksView: { ...s.tasksView, ...change } })),
      openTask: (taskId) => {
        const id = taskTabId(taskId);
        set((s) => ({ open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id, narrowView: "side" as const }));
      },
      openTerminal: (paneId, pid) => {
        const id = terminalTabId(paneId, pid);
        set((s) => ({ open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id, narrowView: "side" as const }));
      },
      history: false,
      historyPlace: null,
      historyOpened: 0,
      openHistory: (place) => set((s) => ({
        open: true, history: true, active: "history",
        ...(place !== undefined ? { historyPlace: place, historyOpened: s.historyOpened + 1 } : {}),
        // As a thread tab: a narrow row turns to the side, narrow yet or not.
        narrowView: "side" as const
      })),
      closeHistory: (shown, before) => set((s) => ({
        history: false, historyPlace: null,
        ...(s.order ? { order: s.order.filter((t) => t !== "history") } : {}),
        active: s.active === "history" ? tabAfterClose(s.recent, "history", (t) => inRow({ ...s, history: false }, t, shown), before ?? "page") : s.active
      })),
      setHistoryPlace: (historyPlace) => set({ historyPlace })
      };
    },
    {
      name: "mandate.agent-page.v1",
      // Another window of this browser may have moved the tabs since: its
      // newer order stays, whatever this one saves about the rest, with the
      // thread tabs' times it was kept against.
      storage: storageKeeping<Partial<AgentPageUiState>>((saving, saved) =>
        (saved?.order && (saved.orderAt ?? 0) > (saving.orderAt ?? 0) ? { ...saving, order: saved.order, orderAt: saved.orderAt, threadSeen: saved.threadSeen } : saving)),
      merge: (persisted, current) => {
        const saved = persisted as Partial<AgentPageUiState> | undefined;
        // Only the Tasks, Notes and Calendar tabs, canvas, file, task and terminal tabs: anything else saved there names nothing.
        const tabs = Array.isArray(saved?.tabs)
          ? saved.tabs.filter((tab): tab is string => typeof tab === "string" && (tab === TASKS_TAB || tab === NOTES_TAB || tab === CALENDAR_TAB || canvasIdOfTab(tab) !== null || filePathOfTab(tab) !== null || taskIdOfTab(tab) !== null || terminalOfTab(tab) !== null))
          : [];
        return {
          ...current,
          open: typeof saved?.open === "boolean" ? saved.open : current.open,
          maximized: saved?.maximized === true,
          ratio: clampRatio(saved?.ratio),
          tabs,
          fileLines: saved?.fileLines && typeof saved.fileLines === "object" ? saved.fileLines : {},
          // A reply or thread tab is the server's: whether it is still there is read later.
          active: typeof saved?.active === "string"
            && (tabs.includes(saved.active) || replyIdOfTab(saved.active) !== null || threadIdOfTab(saved.active) !== null) ? saved.active : "page",
          // Whether the version has that page is told when it is drawn.
          pagePath: typeof saved?.pagePath === "string" && saved.pagePath ? saved.pagePath : AGENT_PAGE_FIRST,
          // An order saved as anything but a list of tab ids names none. History
          // is not restored, so neither is its place: opened again, it comes last.
          order: Array.isArray(saved?.order) && saved.order.every((id) => typeof id === "string") ? saved.order.filter((id) => id !== "history") : undefined,
          orderAt: typeof saved?.orderAt === "number" ? saved.orderAt : undefined,
          threadSeen: saved?.threadSeen && typeof saved.threadSeen === "object"
            ? Object.fromEntries(Object.entries(saved.threadSeen).filter(([, at]) => typeof at === "string"))
            : undefined
        };
      },
      partialize: (state) => ({ open: state.open, maximized: state.maximized, ratio: state.ratio, tabs: state.tabs, active: state.active, fileLines: state.fileLines, pagePath: state.pagePath, order: state.order, orderAt: state.orderAt, threadSeen: state.threadSeen })
    }
  )
);

/** Whether the personal agent's row has this tab: Page, History while open,
 *  a canvas or file among `tabs`, a thread's or reply's tab while the
 *  server's list has it; only those `shown` when the row shows only some. */
function inRow(s: Pick<AgentPageUiState, "tabs" | "history">, tabId: string, shown?: (tabId: string) => boolean): boolean {
  if (shown && !shown(tabId)) return false;
  if (tabId === "page") return true;
  if (tabId === "history") return s.history;
  if (s.tabs.includes(tabId)) return true;
  if (threadIdOfTab(tabId) !== null) return (useThreadTabsStore.getState().tabs ?? []).some((tab) => threadTabId(tab.threadId) === tabId);
  if (replyIdOfTab(tabId) !== null) return [...useReplyTabsStore.getState().byThread.values()].some((tabs) => tabs.some((tab) => replyTabId(tab.id) === tabId));
  return false;
}

// A thread tab gone from the server's list (closed on another device) leaves
// the order the person dragged the row into, the panel drawn or not (a hidden
// panel is not): opened again, it comes last.
useThreadTabsStore.subscribe((state, before) => {
  if (state.tabs === null || state.tabs === before.tabs) return;
  const ui = useAgentPageUi.getState();
  // One the server made again (closed and opened elsewhere while this browser
  // was away or shut) is a new tab too: told by when the server made it, as
  // last heard here.
  const seen = Object.fromEntries(state.tabs.map((tab) => [threadTabId(tab.threadId), tab.createdAt]));
  const was = before.tabs ? Object.fromEntries(before.tabs.map((tab) => [threadTabId(tab.threadId), tab.createdAt])) : ui.threadSeen ?? {};
  const order = ui.order;
  if (order) {
    const kept = order.filter((id) => threadIdOfTab(id) === null || (id in seen && (!(id in was) || was[id] === seen[id])));
    if (kept.length !== order.length) ui.keepTabOrder(kept);
  }
  if (JSON.stringify(seen) !== JSON.stringify(ui.threadSeen ?? {})) useAgentPageUi.setState({ threadSeen: seen });
});
