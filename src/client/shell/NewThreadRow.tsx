import { Link } from "react-router";
import { SquarePen } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { collapsedLinkClass, expandedLinkClass } from "@/shell/NavItemRow";
import { cn } from "@/lib/utils";

/** The first row: start a thread. It opens Home (what waits on you, and the
 *  composer), so it is Home's one entry, and it carries the waiting count:
 *  beside its label, or on the icon alone when collapsed. One row for the
 *  desktop sidebar and the phone's drawer, and a nav row like the others —
 *  shape, type, colour, current fill. Its place and its pencil mark it,
 *  rather than an emphasised row. */
export function NewThreadRow({ collapsed = false, current, waiting, onNavigate }: {
  collapsed?: boolean;
  current: boolean;
  waiting: { count: number; urgent: boolean; failed: boolean };
  /** Fires on navigation; the phone's drawer closes itself with it. */
  onNavigate?: () => void;
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/home?focus=composer"
            data-slot="new-thread"
            aria-label="New thread"
            aria-current={current ? "page" : undefined}
            onClick={onNavigate}
            className={cn(collapsedLinkClass, current && "active")}
          >
            <SquarePen className="h-4 w-4" />
            <AttentionBadge count={waiting.count} urgent={waiting.urgent} failed={waiting.failed} floating />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">New thread</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link
      to="/home?focus=composer"
      data-slot="new-thread"
      aria-current={current ? "page" : undefined}
      onClick={onNavigate}
      className={cn(expandedLinkClass, current && "active")}
    >
      <SquarePen className="size-4 shrink-0" />
      New thread
      <span className="ml-auto"><AttentionBadge count={waiting.count} urgent={waiting.urgent} failed={waiting.failed} /></span>
    </Link>
  );
}
