import { Link } from "react-router";
import { StickyNote } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { collapsedLinkClass, expandedLinkClass } from "@/shell/NavItemRow";
import { useUnseenNotes } from "@/routes/sticky-notes/unseen-notes";
import { cn } from "@/lib/utils";

/** The Notes page's entry, after Tasks: the notes not seen yet, as a count to look at. */
export function NotesNavRow({ collapsed = false, current, onNavigate }: {
  collapsed?: boolean;
  current: boolean;
  /** Fires on navigation; the phone's drawer closes itself with it. */
  onNavigate?: () => void;
}) {
  const unseen = useUnseenNotes();
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to="/notes" data-slot="notes-nav" aria-label="Notes" aria-current={current ? "page" : undefined} onClick={onNavigate} className={cn(collapsedLinkClass, current && "active")}>
            <StickyNote className="h-4 w-4" />
            <AttentionBadge count={unseen} urgent={false} floating />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Notes</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link to="/notes" data-slot="notes-nav" aria-current={current ? "page" : undefined} onClick={onNavigate} className={cn(expandedLinkClass, current && "active")}>
      <StickyNote className="size-4 shrink-0" />
      Notes
      <span className="ml-auto">
        <AttentionBadge count={unseen} urgent={false} />
      </span>
    </Link>
  );
}
