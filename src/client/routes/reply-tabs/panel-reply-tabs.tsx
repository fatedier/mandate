import { useMemo, useState } from "react";
import { MessageSquareText } from "lucide-react";
import type { PanelTabItem } from "@/components/PanelTabRow";
import { useShownTabGone } from "@/hooks/useShownTabGone";
import { orderedIds, replyIdOfTab, replyTabId } from "@/lib/panel-tabs";
import { useReplyTabs, useReplyTabsStore } from "@/store/reply-tabs";
import type { ReplyTabDto } from "@shared/api-contracts";
import { replyTabLabel } from "./reply-tab-label";

interface PanelReplyTabsOptions {
  /** The tab shown: the panel's own id for it. */
  active: string;
  /** The closable tabs before the reply tabs in the row, in order. */
  before: readonly string[];
  /** The order the person dragged the row into: the tab before a reply
   *  that goes is read from the row as drawn. */
  order?: readonly string[];
  /** The row's fixed first tab (Page, Workers). */
  home: string;
  /** The reply tab in sight is gone; `before` is the tab before it in the row. */
  gone: (tabId: string, before: string) => void;
}

const isReplyTab = (tabId: string) => replyIdOfTab(tabId) !== null;

/** A right panel's reply tabs (the personal agent's, a thread's), after its other
 *  tabs: one per reply opened there, named by the reply's first line. Close
 *  removes it on every device; a shown one that goes (closed here or on
 *  another device) is told to the panel, which goes back. */
export function usePanelReplyTabs(threadId: string, options: PanelReplyTabsOptions): {
  items: PanelTabItem[];
  ids: string[];
  activeReply: ReplyTabDto | null;
  /** The replies to draw: each from the first time its tab shows, kept while
   *  it is open, so one switched back to is as it was left (its place in a
   *  long reply), as canvas tabs are. */
  kept: ReplyTabDto[];
} {
  const { active, home, gone } = options;
  const tabs = useReplyTabs(threadId);
  const loaded = useReplyTabsStore((s) => s.byThread.has(threadId));
  const ids = tabs.map((tab) => replyTabId(tab.id));
  const row = orderedIds([...options.before, ...ids], options.order);

  useShownTabGone({ row, loaded, active, home, gone, owns: isReplyTab });

  // Read once per list the server gives (the store keeps it between answers):
  // the panel redraws on any activity in the thread, and parsing a long
  // reply's markdown each time stalled it.
  const labels = useMemo(() => new Map(tabs.map((tab) => [tab.id, replyTabLabel(tab.text)])), [tabs]);
  const items = tabs.map((tab): PanelTabItem => {
    const id = replyTabId(tab.id);
    return {
      id,
      label: labels.get(tab.id) ?? "Reply",
      icon: <MessageSquareText aria-hidden className="size-3.5 shrink-0" />,
      group: "Replies",
      // Shown, it gives way once the server's list no longer has it (the
      // effect above). A close the server refused reads the list again: the
      // tab may be gone already (closed on another device, its event missed);
      // if it is not, it stays, to try again.
      onClose: () => {
        const store = useReplyTabsStore.getState();
        void store.remove(threadId, tab.id).catch(() => store.load(threadId));
      },
      dataReplyTab: tab.id
    };
  });
  const activeReply = tabs.find((tab) => replyTabId(tab.id) === active) ?? null;
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(() => new Set());
  if (activeReply && !drawn.has(activeReply.id)) setDrawn(new Set(drawn).add(activeReply.id));
  const kept = tabs.filter((tab) => tab === activeReply || drawn.has(tab.id));
  return { items, ids, activeReply, kept };
}
