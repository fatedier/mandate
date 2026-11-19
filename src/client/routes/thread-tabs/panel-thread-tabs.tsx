import type { PanelTabItem } from "@/components/PanelTabRow";
import { useShownTabGone } from "@/hooks/useShownTabGone";
import { orderedIds, threadIdOfTab, threadTabId } from "@/lib/panel-tabs";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadTabs, useThreadTabsStore } from "@/store/thread-tabs";
import { ThreadTabMark } from "./ThreadTabMark";

const isThreadTab = (tabId: string) => threadIdOfTab(tabId) !== null;

/** A thread's name, open or archived; "Thread" while neither list has it. */
export function useThreadTitle(threadId: string): string {
  return useManagerThreadsStore((s) => s.threads.get(threadId)?.title ?? s.archived.find((t) => t.id === threadId)?.title ?? "Thread");
}

/** The personal agent's thread tabs, first after Page: one per manager thread opened
 *  beside it, named by the thread, with the sidebar's mark of its state.
 *  Close closes it on every device; a shown one that goes (closed here or on
 *  another device, or the thread deleted) is told to the panel, which goes back. */
export function usePanelThreadTabs({ active, before, after = [], order, home, gone }: {
  /** The tab shown: the panel's own id for it. */
  active: string;
  /** The closable tabs before the thread tabs in the row, in order. */
  before: readonly string[];
  /** Those after them, in order. */
  after?: readonly string[];
  /** The order the person dragged the row into: the tab before a thread
   *  that goes is read from the row as drawn. */
  order?: readonly string[];
  /** The row's fixed first tab. */
  home: string;
  /** The thread tab in sight is gone; `before` is the tab before it in the row. */
  gone: (tabId: string, before: string) => void;
}): { items: PanelTabItem[]; ids: string[]; activeThreadId: string | null } {
  const tabs = useThreadTabs();
  const loaded = useThreadTabsStore((s) => s.tabs !== null);
  const titles = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  const ids = tabs.map((tab) => threadTabId(tab.threadId));
  useShownTabGone({ row: orderedIds([...before, ...ids, ...after], order), loaded, active, home, gone, owns: isThreadTab });
  const items = tabs.map((tab): PanelTabItem => ({
    id: threadTabId(tab.threadId),
    label: titles.get(tab.threadId)?.title ?? archived.find((t) => t.id === tab.threadId)?.title ?? "Thread",
    icon: <ThreadTabMark threadId={tab.threadId} />,
    group: "Threads",
    // A close the server refused reads the list again: the tab may be gone
    // already (closed on another device, its event missed).
    onClose: () => {
      const store = useThreadTabsStore.getState();
      void store.remove(tab.threadId).catch(() => store.load());
    },
    dataThreadTab: tab.threadId
  }));
  const activeThreadId = ids.includes(active) ? threadIdOfTab(active) : null;
  return { items, ids, activeThreadId };
}
