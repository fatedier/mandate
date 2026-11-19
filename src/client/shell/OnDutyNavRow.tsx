import { useMemo } from "react";
import { Link } from "react-router";
import { CalendarClock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { collapsedLinkClass, expandedLinkClass } from "@/shell/NavItemRow";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { dutyFailing } from "@/lib/duty";
import { cn } from "@/lib/utils";

/** The On duty page's entry, in a fixed place: how many duty threads have a
 *  check failing, red, and nothing else. A report they sent went to the
 *  personal agent, where the owner reads it, and a total of threads on duty
 *  waits on no one. Nothing joins or leaves the nav with a check's state. */
export function OnDutyNavRow({ collapsed = false, current, onNavigate }: {
  collapsed?: boolean;
  current: boolean;
  /** Fires on navigation; the phone's drawer closes itself with it. */
  onNavigate?: () => void;
}) {
  const threads = useManagerThreadsStore((s) => s.threads);
  const failing = useMemo(
    () => [...threads.values()].filter((t) => t.duty != null && dutyFailing(t.duty)).length,
    [threads]
  );
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to="/duty" data-slot="on-duty-nav" aria-label="On duty" aria-current={current ? "page" : undefined} onClick={onNavigate} className={cn(collapsedLinkClass, current && "active")}>
            <CalendarClock className="h-4 w-4" />
            <AttentionBadge count={failing} urgent failed floating />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">On duty</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link to="/duty" data-slot="on-duty-nav" aria-current={current ? "page" : undefined} onClick={onNavigate} className={cn(expandedLinkClass, current && "active")}>
      <CalendarClock className="size-4 shrink-0" />
      On duty
      {failing > 0 && <span className="ml-auto"><AttentionBadge count={failing} urgent failed /></span>}
    </Link>
  );
}
