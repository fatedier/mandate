import { CalendarDays } from "lucide-react";
import type { PanelTabItem } from "@/components/PanelTabRow";
import { CALENDAR_TAB } from "@/lib/panel-tabs";
import { useAgentPageUi } from "@/store/agent-page-ui";

/** The Calendar tab in the agent's panel row, while it is open: closed like a thread's tab. */
export function useCalendarPanelTab(open: boolean, shown?: (tabId: string) => boolean): PanelTabItem[] {
  if (!open) return [];
  return [{
    id: CALENDAR_TAB,
    label: "Calendar",
    icon: <CalendarDays aria-hidden className="size-3.5 shrink-0" />,
    onClose: () => useAgentPageUi.getState().closeTab(CALENDAR_TAB, undefined, shown),
    dataCalendarTab: true
  }];
}
