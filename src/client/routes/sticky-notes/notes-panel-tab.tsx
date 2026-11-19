import { StickyNote } from "lucide-react";
import type { PanelTabItem } from "@/components/PanelTabRow";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { NOTES_TAB } from "@/lib/panel-tabs";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useUnseenNotes } from "./unseen-notes";

/** The Notes tab in the agent's panel row, while it is open: closed like a
 *  thread's tab, its count of the notes not seen yet after its name. */
export function useNotesPanelTab(open: boolean, shown?: (tabId: string) => boolean): PanelTabItem[] {
  const unseen = useUnseenNotes();
  if (!open) return [];
  return [{
    id: NOTES_TAB,
    label: "Notes",
    icon: <StickyNote aria-hidden className="size-3.5 shrink-0" />,
    onClose: () => useAgentPageUi.getState().closeTab(NOTES_TAB, undefined, shown),
    dataNotesTab: true,
    after: unseen > 0 ? <AttentionBadge count={unseen} urgent={false} /> : undefined
  }];
}
