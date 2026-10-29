import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, Hourglass, Layers, Square } from "lucide-react";
import { toast } from "sonner";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSecondClock } from "@/hooks/useSecondClock";
import { formatDateTimeTitle, formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { SheetCloseButton, StopTaskButton, TaskClock, TaskSteps } from "./TaskSteps";
import { useCloseWhenCovered } from "./useCloseWhenCovered";
import { useTaskStep } from "./useTaskStep";
import { WorkingGlyph } from "./WorkingIndicator";
import {
  doneTimeLabel, taskCountsLine, taskKindLabel, taskOutcomeLabel, taskRunMs, taskSections, useHasBackgroundTasks,
  type TaskSections
} from "./background-tasks-view";

const NO_TASKS: readonly BackgroundTaskDto[] = [];
/** A section's heading. */
const HEAD = "label-micro px-2 pt-1 text-faint";

/** A thread's background tasks: the running and queued ones first, each with
 *  Stop, then the ones done, latest first. A row opens its steps and its
 *  reply (TaskSteps) in the list's place, with ‹ back. With
 *  `onClose` it sits in a surface of its own (the phone's sheet): the list's
 *  header row holds its × at the end, and a task's own header row holds ‹,
 *  its title, Stop and × (TaskSteps' `close`), one row at each level. */
export function BackgroundTasksList({ threadId, onClose }: { threadId: string; onClose?: () => void }) {
  const tasks = useBackgroundTasksStore((s) => s.byThread.get(threadId)) ?? NO_TASKS;
  const pages = useBackgroundTasksStore((s) => s.pages.get(threadId));
  const loadOlder = useBackgroundTasksStore((s) => s.loadOlder);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sections = useMemo(() => taskSections(tasks), [tasks]);
  // Read from the store each time: an open task's changes reach its detail.
  const selected = selectedId === null ? null : tasks.find((task) => task.id === selectedId) ?? null;
  const counts = taskCountsLine(sections);
  const older = pages?.olderDone
    ? {
        loading: pages.loadingOlder,
        load: async () => {
          const reason = await loadOlder(threadId);
          if (reason) toast.error(`Couldn't load older tasks: ${reason}`);
        }
      }
    : null;
  // The surface that scrolls it (the popover, the sheet's body). A task opens
  // at its top, its header in view, wherever the list was scrolled to; ‹
  // goes back to where the list was.
  const rootRef = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  const scroller = () => rootRef.current?.closest<HTMLElement>('[data-slot="background-tasks-popover"], [data-slot="bottom-sheet-body"]') ?? null;
  const openTask = (taskId: string) => {
    listScrollTop.current = scroller()?.scrollTop ?? 0;
    setSelectedId(taskId);
  };
  const shownId = selected?.id ?? null;
  useLayoutEffect(() => {
    const surface = scroller();
    if (surface) surface.scrollTop = shownId === null ? listScrollTop.current : 0;
  }, [shownId]);
  if (selected) {
    return (
      <div ref={rootRef} data-slot="background-tasks" className="flex flex-col gap-2">
        <TaskSteps task={selected} onBack={() => setSelectedId(null)} close={onClose ? <SheetCloseButton onClick={onClose} /> : undefined} />
      </div>
    );
  }
  return (
    <div ref={rootRef} data-slot="background-tasks" className="flex flex-col gap-2">
      {onClose ? (
        <div className="sticky top-0 z-10 flex items-center gap-1 bg-background pb-1">
          {/* As many 44px places at each end: the title is centred. */}
          <span aria-hidden className="size-11 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col items-center">
            <span className="max-w-full truncate text-sm font-semibold text-foreground">Background tasks</span>
            <span data-slot="background-tasks-counts" className="max-w-full truncate text-2xs text-faint">{counts}</span>
          </div>
          <SheetCloseButton onClick={onClose} />
        </div>
      ) : (
        <div className="flex flex-col px-2">
          <span className="text-sm font-medium text-foreground">Background tasks</span>
          <span data-slot="background-tasks-counts" className="text-2xs text-faint">{counts}</span>
        </div>
      )}
      <TaskRows sections={sections} onOpen={openTask} older={older} />
    </div>
  );
}

function TaskRows({ sections, onOpen, older }: {
  sections: TaskSections;
  onOpen: (taskId: string) => void;
  /** Older done tasks not read yet: a control at the Done section's end reads the next page. */
  older: { loading: boolean; load: () => Promise<void> } | null;
}) {
  // When a done task ended reads its day against now.
  const now = useSecondClock();
  const { running, queued, done } = sections;
  if (running.length + queued.length + done.length === 0) {
    return <p className="px-2 pb-2 text-sm text-muted-foreground">No background tasks.</p>;
  }
  return (
    <div className="flex flex-col">
      {running.length > 0 && (
        <TaskSection name="running" title="Running" first>
          {running.map((task) => <OpenTaskRow key={task.id} task={task} onOpen={onOpen} />)}
        </TaskSection>
      )}
      {queued.length > 0 && (
        <TaskSection name="queued" title="Queued" first={running.length === 0}>
          {queued.map((task) => <OpenTaskRow key={task.id} task={task} onOpen={onOpen} />)}
        </TaskSection>
      )}
      {done.length > 0 && (
        <TaskSection name="done" title="Done" first={running.length + queued.length === 0}>
          {done.map((task) => <DoneTaskRow key={task.id} task={task} now={now} onOpen={onOpen} />)}
          {older && (
            <button
              type="button"
              data-slot="background-tasks-older"
              disabled={older.loading}
              onClick={() => void older.load()}
              className="mt-1 flex min-h-8 items-center self-start rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:bg-sel hover:text-foreground disabled:opacity-60 pointer-coarse:min-h-11"
            >
              Show older
            </button>
          )}
        </TaskSection>
      )}
    </div>
  );
}

function TaskSection({ name, title, first, children }: { name: string; title: string; first: boolean; children: ReactNode }) {
  return (
    <section data-slot="background-tasks-section" data-section={name} aria-label={title} className="flex flex-col">
      <h3 className={cn(HEAD, !first && "pt-3")}>{title}</h3>
      {children}
    </section>
  );
}

/** Its title and kind: "Find the retry call sites · Subagent". */
function TaskName({ task }: { task: BackgroundTaskDto }) {
  return (
    <span data-slot="background-task-name" className="truncate text-sm">
      <span className="font-medium text-foreground">{task.title}</span>
      <span className="text-faint"> · {taskKindLabel(task)}</span>
    </span>
  );
}

/** A running or queued task: the call it is on (or Queued), how long it has
 *  run (a queued one has no clock: it has not started), and Stop. */
function OpenTaskRow({ task, onOpen }: { task: BackgroundTaskDto; onOpen: (taskId: string) => void }) {
  const step = useTaskStep(task);
  const running = task.status === "running";
  return (
    <div data-slot="background-task-row" data-status={task.status} className="flex min-w-0 items-center gap-1 rounded-sm hover:bg-sel">
      <button type="button" onClick={() => onOpen(task.id)} className="flex min-w-0 flex-1 items-start gap-2 px-2 py-2 text-left pointer-coarse:py-3">
        {running ? <WorkingGlyph /> : <Hourglass aria-hidden className="mt-0.5 size-3.5 shrink-0 text-chrome" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <TaskName task={task} />
          <span data-slot="background-task-step" className={cn("truncate text-xs", running && task.kind !== "command" ? "text-shimmer" : "text-muted-foreground")}>
            {/* A command's step is its output's last line, said as it is. */}
            {!running ? "Queued" : task.kind === "command" ? step ?? "Running" : `${step ?? "Working"}…`}
          </span>
        </span>
        <TaskClock task={task} slot="background-task-clock" className="shrink-0 pt-0.5 text-xs tabular-nums text-faint" />
      </button>
      <StopTaskButton task={task} variant="icon" />
    </div>
  );
}

/** A task that ended: how, for how long, and when; it opens its steps. */
function DoneTaskRow({ task, now, onOpen }: { task: BackgroundTaskDto; now: number; onOpen: (taskId: string) => void }) {
  const duration = taskRunMs(task, now);
  const outcome = taskOutcomeLabel(task);
  return (
    <button
      type="button"
      data-slot="background-task-row"
      data-status={task.status}
      onClick={() => onOpen(task.id)}
      className="flex min-w-0 items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-sel pointer-coarse:py-3"
    >
      <DoneMark task={task} />
      <span className="flex min-w-0 flex-1 flex-col">
        <TaskName task={task} />
        <span data-slot="background-task-outcome" className={cn("truncate text-xs", task.status === "failed" ? "text-red" : "text-muted-foreground")}>
          {duration === null ? outcome : `${outcome} · ${formatElapsedClock(duration)}`}
        </span>
      </span>
      <time
        data-slot="background-task-time"
        dateTime={task.finishedAt ?? undefined}
        title={formatDateTimeTitle(task.finishedAt)}
        className="shrink-0 pt-0.5 text-xs tabular-nums text-faint"
      >
        {doneTimeLabel(task, now)}
      </time>
      <ChevronRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint" />
    </button>
  );
}

function DoneMark({ task }: { task: BackgroundTaskDto }) {
  const Icon = task.status === "finished" ? Check : task.status === "stopped" ? Square : CircleAlert;
  return (
    <span aria-hidden className={cn("flex w-3.5 shrink-0 justify-center pt-0.5", task.status === "failed" ? "text-red" : "text-faint")}>
      <Icon className={task.status === "stopped" ? "size-3 fill-current" : "size-3.5"} />
    </span>
  );
}

/** Where a thread's list opens: on a desktop a popover against `anchor` (the
 *  ⋯ button it is chosen from, below it; the strip's folded row, above it),
 *  on a phone a sheet. Mounted with the menu it belongs to, it reads the
 *  thread's tasks, so the menu knows whether to offer them. */
export function BackgroundTasksPanel({ threadId, open, onOpenChange, anchor, side, align, focusFallback }: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: HTMLElement | null;
  side: "top" | "bottom";
  align: "start" | "end";
  /** Where focus goes when it closes and `anchor` is gone (the strip's row
   *  drawn anew as it closed). */
  focusFallback?: FocusFallback;
}) {
  const isMobile = useIsMobile();
  const load = useBackgroundTasksStore((s) => s.load);
  useEffect(() => {
    void load(threadId).catch(() => {});
  }, [load, threadId]);
  // A canvas opened from a link in a task's reply covers the page: the list closes.
  useCloseWhenCovered(open, () => onOpenChange(false));
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  // Closed by Esc, focus goes back to what it opened from: with no trigger
  // of its own the popover gives it to nothing. A press elsewhere keeps the
  // focus that press gave.
  const closedByEscape = useRef(false);
  if (isMobile) {
    return (
      <BottomSheet
        open={open}
        onOpenChange={onOpenChange}
        slot="background-tasks-sheet"
        bodyClassName="px-2 pb-4"
        // Opened from a menu item or the strip's row: focus goes back there,
        // or, the row drawn anew, to what replaced it (never the composer:
        // on a phone that would raise the keyboard).
        returnFocus={() => (anchor?.isConnected ? anchor : focusFallback?.({ composer: false }) ?? null)}
        // Named for a screen reader; on screen the list's own header row says it.
        header={<BottomSheetTitle className="sr-only">Background tasks</BottomSheetTitle>}
      >
        <BackgroundTasksList threadId={threadId} onClose={() => onOpenChange(false)} />
      </BottomSheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        data-slot="background-tasks-popover"
        aria-label="Background tasks"
        side={side}
        align={align}
        sideOffset={8}
        collisionPadding={12}
        // Chosen from a menu: the menu, closing, may give focus back to its
        // button; that is not leaving the list, and the list takes no focus.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={() => { closedByEscape.current = true; }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (closedByEscape.current) (anchor?.isConnected ? anchor : focusFallback?.({ composer: true }))?.focus();
          closedByEscape.current = false;
        }}
        // A press on what it opens from is that control's own: the folded
        // row closes it again, the ⋯ opens its menu (which closes the list).
        onInteractOutside={(event) => {
          if (anchor?.contains(event.target as Node)) event.preventDefault();
        }}
        className="flex max-h-[min(640px,var(--radix-popover-content-available-height))] w-[min(560px,calc(100vw-32px))] flex-col overflow-y-auto p-3"
      >
        <BackgroundTasksList threadId={threadId} />
      </PopoverContent>
    </Popover>
  );
}

/** The ⋯ menu's first item: the thread's background tasks. Nothing until
 *  it has started one. */
export function BackgroundTasksMenuItem({ threadId, onOpen }: { threadId: string; onOpen: () => void }) {
  if (!useHasBackgroundTasks(threadId)) return null;
  return (
    <DropdownMenuItem onSelect={onOpen}>
      <Layers className="h-4 w-4" />
      Background tasks
    </DropdownMenuItem>
  );
}

/** What takes focus when a surface closes and the control it opened from is
 *  gone: the strip's row that replaced it, or the composer (`composer`: may
 *  it be, where focusing it does not raise a keyboard). */
export type FocusFallback = (options: { composer: boolean }) => HTMLElement | null;

/** What the strip's folded row spreads onto its button to open the list. */
interface RowOpener {
  ref: (element: HTMLButtonElement | null) => void;
  onClick: () => void;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
}

/** The strip's folded row opens the thread's list above itself (a sheet on
 *  a phone), and closes it again. The strip draws the row; this
 *  gives it what opens the list. */
export function BackgroundTasksFromRow({ threadId, onOpenChange, focusFallback, children }: {
  threadId: string;
  /** Its list opened or closed (also when it goes with the row). */
  onOpenChange?: (open: boolean) => void;
  focusFallback?: FocusFallback;
  children: (row: RowOpener) => ReactNode;
}) {
  const [row, setRow] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  // Gone while its list is open (the composer it sits above gave way to
  // voice): the list went with it, and is told closed.
  const told = useRef({ open, onOpenChange });
  useEffect(() => { told.current = { open, onOpenChange }; });
  useEffect(() => () => {
    if (told.current.open) told.current.onOpenChange?.(false);
  }, []);
  return (
    <>
      {children({ ref: setRow, onClick: () => change(!open), "aria-haspopup": "dialog", "aria-expanded": open })}
      <BackgroundTasksPanel threadId={threadId} open={open} onOpenChange={change} anchor={row} side="top" align="start" focusFallback={focusFallback} />
    </>
  );
}
