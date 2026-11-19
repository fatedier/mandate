import { CalendarView } from "./CalendarView";

/** The Calendar tab's view, drawn while its tab is chosen: the calendar the page draws. */
export function CalendarPanelTab() {
  return (
    <div data-slot="calendar-panel" className="flex min-h-0 flex-1 flex-col">
      <CalendarView place="panel" />
    </div>
  );
}
