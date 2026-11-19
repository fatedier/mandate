import { arrayMove } from "@dnd-kit/sortable";

/** A canvas's tab in a right panel (a thread's, the personal agent's), beside the
 *  workers' tabs (a worker id, or `archived:` and one). */
export const CANVAS_TAB = "canvas:";

export function canvasTabId(canvasId: string): string {
  return `${CANVAS_TAB}${canvasId}`;
}

/** The canvas a tab shows, or null for any other tab. */
export function canvasIdOfTab(tabId: string): string | null {
  return tabId.startsWith(CANVAS_TAB) && tabId.length > CANVAS_TAB.length ? tabId.slice(CANVAS_TAB.length) : null;
}

/** A file's tab in a right panel: the file's absolute path after it. */
export const FILE_TAB = "file:";

export function fileTabId(path: string): string {
  return `${FILE_TAB}${path}`;
}

/** The file a tab shows, or null for any other tab. */
export function filePathOfTab(tabId: string): string | null {
  return tabId.startsWith(FILE_TAB) && tabId.length > FILE_TAB.length ? tabId.slice(FILE_TAB.length) : null;
}

/** A reply's tab in a right panel: the reply tab's id after it. The tabs
 *  themselves are the server's (useReplyTabsStore), on every device. */
export const REPLY_TAB = "reply:";

export function replyTabId(id: string): string {
  return `${REPLY_TAB}${id}`;
}

/** The reply tab a tab shows, or null for any other tab. */
export function replyIdOfTab(tabId: string): string | null {
  return tabId.startsWith(REPLY_TAB) && tabId.length > REPLY_TAB.length ? tabId.slice(REPLY_TAB.length) : null;
}

/** A manager thread's tab in the personal agent's panel: the thread's id after it.
 *  The tabs themselves are the server's (useThreadTabsStore), on every device. */
export const THREAD_TAB = "thread:";

export function threadTabId(threadId: string): string {
  return `${THREAD_TAB}${threadId}`;
}

/** The thread a tab shows, or null for any other tab. */
export function threadIdOfTab(tabId: string): string | null {
  return tabId.startsWith(THREAD_TAB) && tabId.length > THREAD_TAB.length ? tabId.slice(THREAD_TAB.length) : null;
}

/** The owner's tasks as a tab of the personal agent's panel: one, the
 *  board, opened from +, closed like a thread's. */
export const TASKS_TAB = "tasks";

/** The personal agent's sticky notes as a tab of its panel: one, the wall,
 *  opened from +, closed like a thread's. */
export const NOTES_TAB = "notes";

/** The personal agent's calendar as a tab of its panel: one, opened from +,
 *  closed like a thread's. */
export const CALENDAR_TAB = "calendar";

/** A task's own tab in the personal agent's panel: the task's id after it. */
export const TASK_TAB = "task:";

export function taskTabId(taskId: string): string {
  return `${TASK_TAB}${taskId}`;
}

/** The task a tab shows, or null for any other tab. */
export function taskIdOfTab(tabId: string): string | null {
  return tabId.startsWith(TASK_TAB) && tabId.length > TASK_TAB.length ? tabId.slice(TASK_TAB.length) : null;
}

/** The one group a right panel's tabs are dragged in (PanelTabRow's
 *  `order`): any of them, of any kind, among all the others. */
export const PANEL_TAB_ORDER = "tabs";

/** A panel's tab ids in the order the person put them in: those `order`
 *  names, in its order, then the rest as `ids` has them (opened since, or
 *  come from the server). An id of `order` no longer open is skipped. No
 *  order: `ids` as they are. */
export function orderedIds(ids: readonly string[], order: readonly string[] | undefined): string[] {
  if (!order) return [...ids];
  const open = new Set(ids);
  const placed = order.filter((id, at) => open.has(id) && order.indexOf(id) === at);
  const named = new Set(placed);
  return [...placed, ...ids.filter((id) => !named.has(id))];
}

/** `orderedIds` for the tabs themselves. */
export function orderedTabs<T extends { id: string }>(row: readonly T[], order: readonly string[] | undefined): T[] {
  if (!order) return [...row];
  const byId = new Map(row.map((tab) => [tab.id, tab]));
  return orderedIds(row.map((tab) => tab.id), order).map((id) => byId.get(id)!);
}

/** `all` (every tab of the panel, in the order shown, those a row hides
 *  too) with `id` in the place of `overId`, the tab it was dropped on; the
 *  others keep their places relative to each other. Unchanged when either is
 *  not there. */
export function movedOrder(all: readonly string[], id: string, overId: string): string[] {
  const from = all.indexOf(id);
  const to = all.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...all];
  return arrayMove([...all], from, to);
}

/** A panel's whole order for a drop: the saved one, then any tab not in it
 *  yet (just come, before the order caught up), in the row's order. No order
 *  yet: the row as it is. */
export function completeOrder(order: readonly string[] | undefined, present: readonly string[]): string[] {
  if (!order) return [...present];
  return [...order, ...present.filter((id) => !order.includes(id))];
}

/** A panel's order kept whole as its tabs come and go, once the person has
 *  given it one: a tab that comes goes last; one gone leaves. `present`:
 *  every tab the panel has, in the row's order. Several that came while the
 *  order was not looked after (the panel not drawn) go in the order they
 *  came, by `cameAt` (a server's tab by when the server made it); the rest
 *  after them as the row has them. A tab `waiting` names (a server's, while
 *  its lists are not all in) is neither taken for gone nor placed yet: once
 *  they are, those that came go in the order the server made them. */
export function reconciledOrder(order: readonly string[], present: readonly string[], cameAt: (id: string) => number = () => Infinity, waiting: (id: string) => boolean = () => false): string[] {
  const here = new Set(present);
  const kept = order.filter((id) => here.has(id) || waiting(id));
  const came = present.filter((id) => !kept.includes(id) && !waiting(id)).map((id, at) => ({ id, at, when: cameAt(id) }));
  came.sort((a, b) => (a.when === b.when ? a.at - b.at : a.when < b.when ? -1 : 1));
  return [...kept, ...came.map((tab) => tab.id)];
}

/** `tabs` with `tabId` back where it stood: after `after` while that is
 *  still there, at the front (behind `lead`, the tabs that keep it) when it
 *  led, else at the end. One there already stays where it is. */
export function withTabBack(tabs: readonly string[], tabId: string, after: string | null, lead: readonly string[] = []): string[] {
  if (tabs.includes(tabId)) return [...tabs];
  let at = tabs.length;
  if (after === null) {
    at = 0;
    while (at < tabs.length && lead.includes(tabs[at]!)) at += 1;
  } else if (tabs.includes(after)) {
    at = tabs.indexOf(after) + 1;
  }
  return [...tabs.slice(0, at), tabId, ...tabs.slice(at)];
}

/** How many of the tabs a panel showed it remembers, latest last. */
const RECENT_TABS = 20;

/** `recent` with `tabId` moved to its end: the tabs a panel showed, latest last. */
export function withShown(recent: readonly string[] | undefined, tabId: string): string[] {
  return [...(recent ?? []).filter((tab) => tab !== tabId), tabId].slice(-RECENT_TABS);
}

/** The tab to show when the shown tab `closed` goes: the latest one shown
 *  before it that the row still has (`inRow`), else `fallback` (the one
 *  before it in the row). The reader goes back to where they were. */
export function tabAfterClose(recent: readonly string[] | undefined, closed: string, inRow: (tabId: string) => boolean, fallback: string): string {
  const shown = recent ?? [];
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const tab = shown[index]!;
    if (tab !== closed && inRow(tab)) return tab;
  }
  return fallback;
}

/** A terminal's tab in the personal agent's panel: the pane's id and the pid
 *  it is known by (tmux gives ids out again after a restart). */
export const TERMINAL_TAB = "terminal:";

export function terminalTabId(paneId: string, pid: number): string {
  return `${TERMINAL_TAB}${paneId}:${pid}`;
}

/** The pane a terminal tab shows, or null for any other tab. */
export function terminalOfTab(tabId: string): { paneId: string; pid: number } | null {
  if (!tabId.startsWith(TERMINAL_TAB)) return null;
  const rest = tabId.slice(TERMINAL_TAB.length);
  const at = rest.lastIndexOf(":");
  const paneId = rest.slice(0, at);
  const pid = Number(rest.slice(at + 1));
  return at > 0 && paneId.startsWith("%") && Number.isInteger(pid) && pid > 0 ? { paneId, pid } : null;
}
