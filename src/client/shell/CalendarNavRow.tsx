import { Link } from "react-router";
import { CalendarDays } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { collapsedLinkClass, expandedLinkClass } from "@/shell/NavItemRow";
import { cn } from "@/lib/utils";

/** The Calendar page's entry, after Notes. No count: nothing on it waits on the user. */
export function CalendarNavRow({ collapsed = false, current, onNavigate }: {
  collapsed?: boolean;
  current: boolean;
  /** Fires on navigation; the phone's drawer closes itself with it. */
  onNavigate?: () => void;
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to="/calendar" data-slot="calendar-nav" aria-label="Calendar" aria-current={current ? "page" : undefined} onClick={onNavigate} className={cn(collapsedLinkClass, current && "active")}>
            <CalendarDays className="h-4 w-4" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Calendar</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link to="/calendar" data-slot="calendar-nav" aria-current={current ? "page" : undefined} onClick={onNavigate} className={cn(expandedLinkClass, current && "active")}>
      <CalendarDays className="size-4 shrink-0" />
      Calendar
    </Link>
  );
}
