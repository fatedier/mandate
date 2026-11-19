import { useMemo } from "react";
import { Link } from "react-router";
import { SquareCheckBig } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { collapsedLinkClass, expandedLinkClass } from "@/shell/NavItemRow";
import { useTaskBoardStore } from "@/store/task-board";
import { isOpen } from "@/routes/task-board/task-format";
import { cn } from "@/lib/utils";

/** The Tasks page's entry, after New thread: how many open tasks need the
 *  owner (a linked thread waits on them), and nothing when none does — a
 *  total of open tasks waits on no one. */
export function TasksNavRow({ collapsed = false, current, onNavigate }: {
  collapsed?: boolean;
  current: boolean;
  /** Fires on navigation; the phone's drawer closes itself with it. */
  onNavigate?: () => void;
}) {
  const tasks = useTaskBoardStore((s) => s.tasks);
  const needYou = useMemo(
    () => (tasks ? [...tasks.values()].filter((t) => isOpen(t) && t.marks.needsYou).length : 0),
    [tasks]
  );
  const badge = needYou > 0 && (
    <span title="Tasks that need you" className="inline-flex">
      <AttentionBadge count={needYou} urgent />
    </span>
  );
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to="/tasks" data-slot="tasks-nav" aria-label="Tasks" aria-current={current ? "page" : undefined} onClick={onNavigate} className={cn(collapsedLinkClass, current && "active")}>
            <SquareCheckBig className="h-4 w-4" />
            {needYou > 0 && <AttentionBadge count={needYou} urgent floating />}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Tasks</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link to="/tasks" data-slot="tasks-nav" aria-current={current ? "page" : undefined} onClick={onNavigate} className={cn(expandedLinkClass, current && "active")}>
      <SquareCheckBig className="size-4 shrink-0" />
      Tasks
      {badge && <span className="ml-auto">{badge}</span>}
    </Link>
  );
}
