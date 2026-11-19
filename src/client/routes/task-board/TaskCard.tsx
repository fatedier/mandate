import { Fragment, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { CalendarDays } from "lucide-react";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { cn } from "@/lib/utils";
import { LabelChip } from "@/components/LabelField";
import type { TaskDto } from "@shared/api/task-board";
import { formatDueLabel, isOpen, taskNote } from "./task-format";
import { TaskActionsButton } from "./TaskActions";

const PILL = "inline-flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-full px-2 text-2xs font-semibold";

/** What the threads and time say of an open task: Needs you, Failed, Quiet
 *  3 days. A closed task says none of them. */
export function TaskMarks({ task }: { task: TaskDto }) {
  if (!isOpen(task)) return null;
  return (
    <>
      {task.marks.needsYou && (
        <span data-slot="task-needs-you" className={cn(PILL, "bg-[color-mix(in_oklab,var(--status-input)_var(--pill-mix),transparent)] text-status-input-fg")}>Needs you</span>
      )}
      {task.marks.failed && (
        <span data-slot="task-failed" className={cn(PILL, "bg-[color-mix(in_oklab,var(--destructive)_var(--pill-mix),transparent)] text-destructive")}>Failed</span>
      )}
      {task.marks.quiet && <span data-slot="task-quiet" className="shrink-0 whitespace-nowrap text-2xs text-faint">Quiet 3 days</span>}
    </>
  );
}

/** An open task's due date, short, beside a calendar as the task's Due
 *  field has: red past, amber today. In a narrow card it breaks between its
 *  parts ("Overdue · / Oct 7, 2025 · / 09:30"), never inside one. */
export function TaskDue({ task, now, className }: { task: TaskDto; now: number; className?: string }) {
  if (!task.dueDate || !isOpen(task)) return null;
  const due = formatDueLabel(task.dueDate, task.dueTime, now);
  const parts = due.short.split(" · ");
  return (
    <span
      data-slot="task-due"
      className={cn("inline-flex min-w-0 items-start gap-1 text-xs tabular-nums", due.tone === "overdue" ? "text-destructive" : due.tone === "today" ? "text-amber" : "text-faint", className)}
    >
      <CalendarDays aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">
        {parts.map((part, i) => (
          <Fragment key={i}>{i > 0 && " "}<span className="whitespace-nowrap">{part}{i < parts.length - 1 && " ·"}</span></Fragment>
        ))}
      </span>
    </span>
  );
}

/** Up to `max` labels, the automatic ones first, then how many more. */
export function TaskLabels({ task, agentName, max = 3 }: { task: TaskDto; agentName: string; max?: number }) {
  if (task.labels.length === 0) return null;
  const more = task.labels.length - max;
  return (
    <>
      {task.labels.slice(0, max).map((label) => <LabelChip key={label.name} label={label} agentName={agentName} />)}
      {more > 0 && <span data-slot="task-label-more" className="shrink-0 text-2xs text-faint">+{more}</span>}
    </>
  );
}

/** Up to `max` linked threads with their dots, then how many more. */
export function TaskThreads({ task, max = 2 }: { task: TaskDto; max?: number }) {
  if (task.threads.length === 0) return null;
  const more = task.threads.length - max;
  return (
    <>
      {task.threads.slice(0, max).map((thread) => (
        <span key={thread.threadId} className="flex min-w-0 items-center gap-1.5">
          <ThreadStateMark dot={thread.dot} />
          <span data-slot="task-thread" className="truncate">{thread.title}</span>
        </span>
      ))}
      {more > 0 && <span className="shrink-0">+{more}</span>}
    </>
  );
}

/** The line under a title: the Result, or the latest comment and who wrote it. */
export function TaskNote({ task, agentName, age, className }: { task: TaskDto; agentName: string; age?: (at: string) => string; className?: string }) {
  const note = taskNote(task, agentName);
  if (!note) return null;
  return (
    <span data-slot="task-note" className={cn("min-w-0 text-faint", className)}>
      <span className="text-muted-foreground">{note.who}</span> · {note.text}{age && note.at ? ` · ${age(note.at)}` : ""}
    </span>
  );
}

/**
 * A task on the board: its title, its line, and what to know at a glance.
 * Pressed (or Enter), it opens; dragged to a column, its status moves there;
 * its "⋯" (or a right-click on it) holds the task's actions.
 */
export function TaskCard({ task, agentName, now, selected, onOpen, onDragStart }: {
  task: TaskDto;
  agentName: string;
  now: number;
  selected: boolean;
  onOpen: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
}) {
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
      draggable
      data-slot="task-card"
      data-task-id={task.id}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
      className={cn(
        "group relative flex w-full cursor-grab flex-col gap-1.5 rounded-lg border bg-background p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:cursor-grabbing",
        selected ? "border-ring/60 bg-sel/40" : "border-border-soft hover:border-border"
      )}
    >
      <span className="line-clamp-3 text-[13px] font-semibold leading-snug text-foreground">{task.title}</span>
      <TaskActionsButton task={task} agentName={agentName} now={now} onOpen={onOpen} open={actions} onOpenChange={setActions} place="corner" />
      <TaskNote task={task} agentName={agentName} className="line-clamp-2 text-xs leading-normal" />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground empty:hidden">
        <TaskMarks task={task} />
        <TaskDue task={task} now={now} />
        <TaskThreads task={task} />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1 empty:hidden">
        <TaskLabels task={task} agentName={agentName} />
      </span>
    </div>
  );
}
