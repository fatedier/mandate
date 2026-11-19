import { useEffect, useRef } from "react";
import type { PanelTabItem, ReopenItem } from "@/components/PanelTabRow";
import { canvasIdOfTab, replyIdOfTab, taskIdOfTab, threadIdOfTab } from "@/lib/panel-tabs";
import { onReopenClosedTab } from "@/lib/reopen-closed-tab";
import { useCanvasTitles } from "@/store/canvas-titles";
import { CLOSED_TABS_LISTED, useClosedTabsStore, type ClosedTab } from "@/store/closed-tabs";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useReplyTabsStore } from "@/store/reply-tabs";
import { useTaskBoardStore } from "@/store/task-board";

const NONE: ClosedTab[] = [];

/**
 * A right panel's Reopen: its tabs recorded as they close (`remember`), and
 * the newest five that can come back listed (`menu`, for PanelTabRow). Left
 * out: one open again (here, from a chat, on another device), one this row
 * does not show (a phone's has no canvas, file or task tabs), one whose thing
 * is gone (a canvas, thread or task deleted). Chosen, a tab leaves the list and
 * `reopen` opens it again; while the panel is in sight the desktop app's
 * Reopen Closed Tab opens the newest.
 */
export function usePanelClosedTabs({ panel, row, own, shows, details, reopen }: {
  panel: string;
  /** The row's closable tabs as drawn: a closed one is named from here. */
  row: readonly PanelTabItem[];
  /** The tabs the panel keeps itself, in order (not the server's thread and
   *  reply tabs): one comes back after the one it followed among them. */
  own: readonly string[];
  /** Whether this row shows such a tab. */
  shows?: (tabId: string) => boolean;
  /** What opening it again needs besides (a file's lines); a reply's text
   *  is found here. */
  details?: (tabId: string) => Pick<ClosedTab, "lines">;
  /** Opens it again; resolving false (the server refused) puts it back. */
  reopen: (tab: ClosedTab) => void | Promise<boolean>;
}): { remember: (tabId: string) => void; menu: { entries: ReopenItem[]; onReopen: (id: string) => void } } {
  const closed = useClosedTabsStore((s) => s.byPanel[panel] ?? NONE);
  const replies = useReplyTabsStore((s) => s.byThread);
  const titles = useCanvasTitles((s) => s.titles);
  const threads = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  const threadsKnown = useManagerThreadsStore((s) => s.loaded && s.archivedLoaded);
  const tasks = useTaskBoardStore((s) => s.tasks);

  const open = new Set([...row.map((tab) => tab.id), ...own]);
  const replyOpen = (reply: NonNullable<ClosedTab["reply"]>) => (replies.get(reply.threadId) ?? []).some((tab) => tab.messageId === reply.messageId);
  const isOpen = (tab: ClosedTab) => open.has(tab.id) || (tab.reply !== undefined && replyOpen(tab.reply));
  const gone = (tabId: string) => {
    const canvasId = canvasIdOfTab(tabId);
    if (canvasId !== null) return titles.get(canvasId) === null;
    const taskId = taskIdOfTab(tabId);
    if (taskId !== null) return tasks !== null && !tasks.has(taskId);
    const threadId = threadIdOfTab(tabId);
    return threadId !== null && threadsKnown && !threads.has(threadId) && !archived.some((t) => t.id === threadId);
  };
  const shown = closed.filter((tab) => !isOpen(tab) && !gone(tab.id) && (!shows || shows(tab.id))).slice(0, CLOSED_TABS_LISTED);

  const remember = (tabId: string) => {
    const item = row.find((tab) => tab.id === tabId);
    if (!item) return;
    const index = own.indexOf(tabId);
    const drawn = row.findIndex((tab) => tab.id === tabId);
    const replyId = replyIdOfTab(tabId);
    const reply = replyId === null ? undefined : [...replies.values()].flat().find((tab) => tab.id === replyId);
    useClosedTabsStore.getState().record(panel, {
      id: tabId, label: item.label, icon: item.icon, closedAt: Date.now(), after: index > 0 ? own[index - 1]! : null,
      rowAfter: drawn > 0 ? row[drawn - 1]!.id : null,
      ...(reply ? { reply: { threadId: reply.threadId, messageId: reply.messageId, text: reply.text } } : {}),
      ...details?.(tabId)
    });
  };
  const onReopen = (id: string) => {
    const tab = shown.find((t) => t.id === id);
    if (!tab) return;
    const store = useClosedTabsStore.getState();
    store.forget(panel, id);
    void Promise.resolve(reopen(tab)).then((done) => { if (done === false) store.record(panel, tab); });
  };

  // The desktop's shortcut: the newest this panel can show, as it is now.
  const newest = useRef<() => void>(() => {});
  useEffect(() => {
    newest.current = () => { if (shown[0]) onReopen(shown[0].id); };
  });
  useEffect(() => onReopenClosedTab(() => newest.current()), []);

  return { remember, menu: { entries: shown, onReopen } };
}
