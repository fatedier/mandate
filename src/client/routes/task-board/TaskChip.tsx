import type { MouseEvent, ReactNode } from "react";
import { useInRouterContext } from "react-router";
import { useNow } from "@/hooks/useNow";
import { cn } from "@/lib/utils";
import { useTaskBoardStore } from "@/store/task-board";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { taskHref } from "./task-links";
import { formatDueLabel, isOpen } from "./task-format";
import { useOpenTask } from "./task-open";

const CHIP = "inline-flex max-w-full items-center gap-1 rounded-md border border-border-soft bg-panel px-1.5 align-middle text-xs leading-5 text-foreground no-underline transition-colors hover:border-border hover:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

/**
 * A task where it is named (a reply, a thread's header, a tool's line): its
 * status icon and title, Overdue and Needs you when they apply, live from
 * the board. Pressed, it opens the task where tasks open from here. A task
 * the board does not have keeps the words it was named by.
 */
export function TaskChip({ id, fallback, title: tooltip = "Open the task", className, inert = false }: {
  id: string;
  fallback?: ReactNode;
  title?: string;
  className?: string;
  /** Drawn inside something pressable (a tool's row): the chip alone, not a link. */
  inert?: boolean;
}) {
  const inRouter = useInRouterContext();
  const task = useTaskBoardStore((s) => s.tasks?.get(id) ?? null);
  const now = useNow();
  const overdue = task?.dueDate && isOpen(task) ? formatDueLabel(task.dueDate, task.dueTime, now).tone === "overdue" : false;
  const needsYou = task ? isOpen(task) && task.marks.needsYou : false;
  const body = (
    <>
      {task && <TaskStatusIcon status={task.status} className="size-3" />}
      <span data-slot="task-chip-title" className="min-w-0 truncate">{task?.title ?? fallback ?? id}</span>
      {overdue && <span data-slot="task-chip-mark" className="shrink-0 text-2xs font-medium text-destructive">Overdue</span>}
      {needsYou && <span data-slot="task-chip-mark" className="shrink-0 text-2xs font-medium text-status-input-fg">Needs you</span>}
    </>
  );
  if (inert) return <span data-slot="task-chip" data-task-id={id} className={cn(CHIP, "pointer-events-none", className)}>{body}</span>;
  if (!inRouter) return <a href={taskHref(id)} data-slot="task-chip" data-task-id={id} title={tooltip} className={cn(CHIP, className)}>{body}</a>;
  return <RoutedChip id={id} tooltip={tooltip} className={className}>{body}</RoutedChip>;
}

function RoutedChip({ id, tooltip, className, children }: { id: string; tooltip: string; className?: string; children: ReactNode }) {
  const open = useOpenTask();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // A plain click opens it here; with a modifier the link is the browser's.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(id);
  };
  return <a href={taskHref(id)} data-slot="task-chip" data-task-id={id} title={tooltip} onClick={onClick} className={cn(CHIP, className)}>{children}</a>;
}
