import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { CalendarView } from "./CalendarView";

/** The Calendar page: the personal agent's calendar, which the panel tab draws too. */
export function CalendarPage() {
  return (
    <div data-slot="calendar-page" className="flex min-h-0 w-full flex-1 flex-col">
      <PaneHeaderTitle>
        <h1 className="truncate text-sm font-semibold text-foreground">Calendar</h1>
      </PaneHeaderTitle>
      <CalendarView place="page" />
    </div>
  );
}
