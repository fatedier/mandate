import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type FocusEvent, type ReactNode, type Ref } from "react";
import { AlarmClock, ChevronRight, Eye, Repeat } from "lucide-react";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { useSecondClock } from "@/hooks/useSecondClock";
import { formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BackgroundTasksFromRow, type FocusFallback } from "./BackgroundTasksList";
import { StopTaskButton, TaskClock, TaskMark, TaskStepsPeek } from "./TaskSteps";
import { stripGroupLabel, taskKindLabel, taskOpen } from "./background-tasks-view";
import { useTaskState } from "./useTaskStep";
import { WorkingGlyph } from "./WorkingIndicator";
import type { WorkerStripRow } from "./worker-strip";

const LINE = "flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-xs text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11";

const NO_TASKS: readonly BackgroundTaskDto[] = [];

/** Above a conversation's composer: what is at work for it and will come back
 *  to it. First a manager thread's workers at work (workerStrip): one is its
 *  own row; two or more are one line, the first of them (the longest running,
 *  else the longest waiting) and how many more are at work and waiting,
 *  which opens in place to a row each. Then the conversation's background
 *  tasks (taskStrip), in any conversation: one is its own row with Stop; two
 *  or more are one row, how many and which, that opens the Background tasks
 *  list. No frame: nothing here wants the user. A line naming one worker
 *  opens it, one naming one task opens its steps, one naming several opens
 *  their list. What runs turns and shimmers as the thread's own working line
 *  does; what waits is still. Each clock counts how long it has been at it. */
export function WorkerStrip({ rows, tasks = NO_TASKS, threadId = null, compact, onOpen, onTaskPeek, pinned = null, onListOpen, focusFallback }: {
  rows: readonly WorkerStripRow[];
  /** The conversation's background tasks at work, in the strip's order (taskStrip). */
  tasks?: readonly BackgroundTaskDto[];
  /** The conversation's thread, whose Background tasks list the folded row opens. */
  threadId?: string | null;
  /** A phone: the workers' folded line and a task row without their step. */
  compact: boolean;
  /** Workers are drawn only where their lines can open what they name. */
  onOpen?: (featureId: string) => void;
  /** A task row's steps opened or closed. */
  onTaskPeek?: (taskId: string, open: boolean) => void;
  /** The task whose steps are open: its own row stays while they are,
   *  however many others are at work (nothing folds under it). */
  pinned?: string | null;
  /** The folded row's list opened, with the tasks it listed, or closed. */
  onListOpen?: (taskIds: readonly string[], open: boolean) => void;
  /** What takes focus when a row's steps or list close as the row is drawn
   *  anew (the strip changing its shape as they close). */
  focusFallback?: FocusFallback;
}) {
  const now = useSecondClock();
  const workers = onOpen && rows.length > 0 ? <WorkerRows rows={rows} compact={compact} now={now} onOpen={onOpen} /> : null;
  const pinnedTask = pinned === null ? undefined : tasks.find((t) => t.id === pinned);
  const lone = pinnedTask ?? (tasks.length === 1 ? tasks[0]! : undefined);
  const task = lone
    ? <TaskStripRow task={lone} compact={compact} onPeek={onTaskPeek} focusFallback={focusFallback} />
    : tasks.length > 1 && threadId !== null ? <TaskGroupRow tasks={tasks} threadId={threadId} onOpenChange={onListOpen} focusFallback={focusFallback} /> : null;
  if (!workers && !task) return null;
  return (
    // Only an opened list of workers gives way on a short screen (it scrolls
    // in what is left), down to its header and one whole row; every other
    // line keeps its height, and so does the strip while no list is open.
    <div data-slot="worker-strip" className="flex shrink-0 flex-col gap-0.5 px-1 pb-0.5 has-[>[data-slot=worker-strip-list]]:min-h-[3.25rem] has-[>[data-slot=worker-strip-list]]:shrink pointer-coarse:has-[>[data-slot=worker-strip-list]]:min-h-[5.75rem] [&>*]:shrink-0 [&>[data-slot=worker-strip-list]]:shrink">
      {workers}
      {task}
    </div>
  );
}

function WorkerRows({ rows, compact, now, onOpen }: {
  rows: readonly WorkerStripRow[];
  compact: boolean;
  now: number;
  onOpen: (featureId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const folds = rows.length > 1;
  const toFold = useRef<HTMLButtonElement>(null);
  const toMore = useRef<HTMLButtonElement>(null);
  const toRow = useRef<HTMLButtonElement>(null);
  // Down to one, the fold is gone, and two again later start folded.
  if (open && !folds) setOpen(false);
  // The control pressed gives way to the other: focus follows to it.
  const moved = useRef(false);
  // What had focus here last, and whether the line was folded: when the fold
  // goes away with focus in it, focus would fall into nothing, so it goes to
  // the row that stays. Focus the reader took elsewhere is left there.
  const lastFocus = useRef<HTMLElement | null>(null);
  const wasFolded = useRef(folds);
  const noteFocus = (event: FocusEvent<HTMLElement>) => { lastFocus.current = event.target; };
  useLayoutEffect(() => {
    const was = wasFolded.current;
    wasFolded.current = folds;
    if (moved.current) {
      moved.current = false;
      (open ? toFold : toMore).current?.focus();
      return;
    }
    const last = lastFocus.current;
    const nowhere = document.activeElement === null || document.activeElement === document.body;
    if (was && !folds && last && !last.isConnected && nowhere) toRow.current?.focus();
  });
  // Once folded or unfolded by hand, the chevron turns as the other line
  // comes in (each line draws its own: they are different rows).
  const [turned, setTurned] = useState(false);
  const toggle = (next: boolean) => { moved.current = true; setTurned(true); setOpen(next); };
  if (!folds || !open) {
    // One worker, or the folded line: the same row in the same place, so
    // focus on it stays as the line folds and unfolds around it.
    return (
      <div data-slot="worker-strip-lead" onFocus={noteFocus} className="flex w-full min-w-0 items-center gap-1.5">
        {/* Folded, as wide as it says, so the count follows its clock; on a
            phone the name and the clock, the count needing the rest. */}
        <StripRow buttonRef={toRow} row={rows[0]!} now={now} onOpen={onOpen} saysWhat={!folds || !compact} className={folds ? "w-auto" : undefined} />
        {folds && (
          <button
            ref={toMore}
            type="button"
            data-slot="worker-strip-more"
            aria-expanded={false}
            aria-controls={listId}
            onClick={() => toggle(true)}
            className={cn(LINE, "w-auto shrink-0")}
          >
            <span>· {moreLabel(rows.slice(1))}</span>
            <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-faint", turned && "animate-in spin-in-90 duration-200")} />
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      <button
        ref={toFold}
        type="button"
        data-slot="worker-strip-fold"
        onFocus={noteFocus}
        aria-expanded
        aria-controls={listId}
        onClick={() => toggle(false)}
        className={cn(LINE, "w-auto self-start pl-5")}
      >
        <span>{countLabel(rows)}</span>
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 rotate-90 text-faint", turned && "animate-in spin-in-[-90deg] duration-200")} />
      </button>
      {/* A short screen gives it a part of its height, never less than a
          whole row, and it scrolls in that: the header stays and the
          composer covers none of it. */}
      <div id={listId} data-slot="worker-strip-list" onFocus={noteFocus} className={cn("-mx-1 flex max-h-[40dvh] min-h-6 flex-col gap-0.5 overflow-y-auto px-1 pointer-coarse:min-h-11", turned && "animate-in fade-in-0 slide-in-from-bottom-1 duration-200")}>
        {rows.map((row) => <StripRow key={row.featureId} row={row} now={now} onOpen={onOpen} />)}
      </div>
    </>
  );
}

/** How many workers are running and how many waiting: "2 at work, 2 waiting". */
function countLabel(rows: readonly WorkerStripRow[]): string {
  const running = rows.filter((row) => row.kind === "running").length;
  const waiting = rows.length - running;
  return [running > 0 && `${running} at work`, waiting > 0 && `${waiting} waiting`].filter(Boolean).join(", ");
}

/** The rest after the first: "1 more at work, 2 waiting", or "2 more waiting"
 *  when none of them runs. */
function moreLabel(rest: readonly WorkerStripRow[]): string {
  const running = rest.filter((row) => row.kind === "running").length;
  const waiting = rest.length - running;
  return [
    running > 0 && `${running} more at work`,
    waiting > 0 && (running > 0 ? `${waiting} waiting` : `${waiting} more waiting`)
  ].filter(Boolean).join(", ");
}

function StripRow({ row, now, onOpen, saysWhat = true, className, buttonRef }: {
  row: WorkerStripRow;
  now: number;
  onOpen: (featureId: string) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  /** The step it is on, or what it waits on, after its name. */
  saysWhat?: boolean;
  className?: string;
}) {
  let says: ReactNode = null;
  if (saysWhat && row.kind === "running") says = <span className="text-shimmer"> · {row.step ?? "Working"}…</span>;
  else if (saysWhat && row.kind === "waiting") says = <span> · {row.wait.lead} <span className={cn(row.wait.mono && "font-mono")}>{row.wait.label}</span></span>;
  return (
    <button ref={buttonRef} type="button" data-slot="worker-strip-row" data-kind={row.kind} onClick={() => onOpen(row.featureId)} className={cn(LINE, className)}>
      <Mark row={row} />
      {/* A long step gives way; the clock does not. */}
      <span data-slot="worker-strip-text" className="min-w-0 truncate">
        <span className="font-medium text-foreground">{row.name}</span>
        {says}
      </span>
      <Clock since={row.since} now={now} />
    </button>
  );
}

/** One task at work: its own row, as a running worker's, with Stop at its
 *  end. Its steps open from it: above it on a desktop, in the sheet on a
 *  phone. */
function TaskStripRow({ task, compact, onPeek, focusFallback }: {
  task: BackgroundTaskDto;
  compact: boolean;
  onPeek?: (taskId: string, open: boolean) => void;
  focusFallback?: FocusFallback;
}) {
  // Gone from the strip, its steps went with it: nothing is held for them.
  useEffect(() => () => onPeek?.(task.id, false), [task.id, onPeek]);
  return (
    <div data-slot="task-strip-row" data-status={task.status} className="flex w-full min-w-0 items-center gap-1">
      <TaskStepsPeek
        task={task}
        side="top"
        onOpenChange={(open) => onPeek?.(task.id, open)}
        focusFallback={focusFallback}
        trigger={(props) => <TaskStripButton task={task} compact={compact} {...props} />}
      />
      {taskOpen(task) && <StopTaskButton task={task} variant="icon" />}
    </div>
  );
}

function TaskStripButton({ task, compact, ...props }: { task: BackgroundTaskDto; compact: boolean } & ComponentProps<"button">) {
  // A phone's line has room for the job, not the step it is on.
  const withStep = !compact;
  const state = useTaskState(task, withStep);
  const said = task.status === "running" && !withStep ? null : state;
  return (
    <button {...props} type="button" data-slot="task-strip-open" className={cn(LINE, "w-auto flex-1")}>
      <TaskMark task={task} />
      {/* A long step gives way; the clock does not. */}
      <span data-slot="worker-strip-text" className="min-w-0 truncate">
        <span className="font-medium text-foreground">{taskKindLabel(task)}</span>
        {" · "}{task.title}
        {said && <span className={cn(task.status === "running" && task.kind !== "command" && "text-shimmer")}>{" · "}{said}</span>}
      </span>
      <TaskClock task={task} slot="worker-strip-clock" className="shrink-0 tabular-nums text-faint" />
    </button>
  );
}

/** Two or more tasks at work: one row, how many and which, with the longest
 *  running one's clock (none while all wait); it opens the conversation's
 *  Background tasks list (BackgroundTasksFromRow: above the row on a
 *  desktop, in the sheet on a phone) and, pressed again, closes it. */
function TaskGroupRow({ tasks, threadId, onOpenChange, focusFallback }: {
  tasks: readonly BackgroundTaskDto[];
  threadId: string;
  /** Its list opened, with the tasks it lists now, or closed. */
  onOpenChange?: (taskIds: readonly string[], open: boolean) => void;
  focusFallback?: FocusFallback;
}) {
  const longest = tasks.find((task) => task.status === "running") ?? null;
  return (
    <BackgroundTasksFromRow threadId={threadId} focusFallback={focusFallback} onOpenChange={(open) => onOpenChange?.(tasks.map((task) => task.id), open)}>
      {(opener) => (
        <button {...opener} type="button" data-slot="task-strip-group" className={LINE}>
          {longest ? <WorkingGlyph /> : <TaskMark task={tasks[0]!} />}
          <span data-slot="worker-strip-text" className="min-w-0 truncate">
            <span className="font-medium text-foreground">{stripGroupLabel(tasks)}</span>
            {" · "}{tasks.map((task) => task.title).join(", ")}
          </span>
          {longest && <TaskClock task={longest} slot="worker-strip-clock" className="shrink-0 tabular-nums text-faint" />}
          <ChevronRight aria-hidden className="size-3 shrink-0 text-faint" />
        </button>
      )}
    </BackgroundTasksFromRow>
  );
}

/** A running worker's turning mark, or what a waiting one waits on. */
function Mark({ row }: { row: WorkerStripRow }) {
  if (row.kind === "running") return <WorkingGlyph />;
  const Icon = row.wait.kind === "pane" ? Eye : row.wait.kind === "alarm" ? AlarmClock : Repeat;
  return <Icon aria-hidden className="size-3.5 shrink-0 text-chrome" />;
}

function Clock({ since, now }: { since: string | null; now: number }) {
  const at = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return <span data-slot="worker-strip-clock" aria-hidden="true" className="shrink-0 tabular-nums text-faint">{formatElapsedClock(Math.max(0, now - at))}</span>;
}
