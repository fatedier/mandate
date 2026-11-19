import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskDto } from "@shared/api/task-board";
import { TaskDue, TaskLabels, TaskMarks, TaskNote, TaskThreads } from "./TaskCard";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { isOpen, taskNote } from "./task-format";
import { TaskActionsButton } from "./TaskActions";

/** A task as a row of the List and Due views: the same facts as a card, on
 *  two lines, and the same "⋯" at its end (a right-click opens it too). A
 *  focusable element, not a button: a button cannot hold the "⋯". */
export function TaskRow({ task, agentName, now, selected, onOpen }: {
  task: TaskDto;
  agentName: string;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const quiet = task.threads.length === 0 && !taskNote(task, agentName) && isOpen(task);
  const [actions, setActions] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setActions(true);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-slot="task-row"
      data-task-id={task.id}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-2.5 border-t border-border-soft px-3.5 py-2.5 text-left transition-colors first:border-t-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
        selected ? "bg-sel" : "hover:bg-sel/50"
      )}
    >
      <TaskStatusIcon status={task.status} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The title keeps 8rem: past that, the marks and the due date go
            under it, whole, the date still at the end. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 flex-[1_1_8rem] truncate text-sm font-semibold text-foreground">{task.title}</span>
          <TaskMarks task={task} />
          <TaskDue task={task} now={now} className="ml-auto shrink-0" />
        </span>
        <span className="flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground empty:hidden">
          <TaskThreads task={task} />
          <TaskNote task={task} agentName={agentName} age={(at) => formatRelativeTime(at, now)} className="truncate" />
          {quiet && <span className="text-faint">No thread yet</span>}
        </span>
        {/* A line of their own: long names wrap, nothing else is pushed out. */}
        {task.labels.length > 0 && (
          <span data-slot="task-row-labels" className="flex min-w-0 flex-wrap items-center gap-1 pt-0.5">
            <TaskLabels task={task} agentName={agentName} />
          </span>
        )}
      </span>
      <TaskActionsButton task={task} agentName={agentName} now={now} onOpen={onOpen} open={actions} onOpenChange={setActions} place="row" />
    </div>
  );
}
