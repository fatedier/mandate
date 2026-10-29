import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type Ref } from "react";
import { Fold } from "@/components/Fold";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, CircleDashed, Square, X } from "lucide-react";
import { toast } from "sonner";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { MarkdownView } from "@/components/MarkdownView";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNow } from "@/hooks/useNow";
import { useSecondClock } from "@/hooks/useSecondClock";
import { useSubagentConversation } from "@/hooks/useSubagentThread";
import { formatUserFacingError } from "@/lib/error-message";
import { errorText } from "@shared/error-text";
import { formatByteSize, formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBackgroundTasksStore, useTaskDetail } from "@/store/background-tasks";
import { markdownToText } from "@/lib/markdown-text";
import { ToolCallDetails } from "./ToolCallDetails";
import { ToolCallRows, ToolCallSheetRows } from "./ToolRun";
import { WorkingGlyph } from "./WorkingIndicator";
import { useTaskStep } from "./useTaskStep";
import { doneTimeLabel, taskKindLabel, taskOpen, taskOutcomeLabel, taskRunMs, taskStepRows } from "./background-tasks-view";
import { collectToolNames } from "./tool-details/names";
import { useCloseWhenCovered } from "./useCloseWhenCovered";
import { ToolNamesContext } from "./tool-details/names-context";
import type { ToolResultSpec } from "./tool-run-summary";

const QUEUED_NOTE = "It starts by itself when one of this conversation's running subagents ends.";

/** A phone sheet's header button, as the tool sheet's: 44px. */
const SHEET_BUTTON = "flex size-11 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-sel";

/** A task's mark: turning while it runs, still while it waits, and how it
 *  ended: done, stopped, red when it failed. */
export function TaskMark({ task }: { task: Pick<BackgroundTaskDto, "status"> }) {
  const mark = "size-3.5 shrink-0";
  switch (task.status) {
    case "running": return <WorkingGlyph />;
    case "queued": return <CircleDashed data-slot="task-mark" aria-hidden className={cn(mark, "text-faint")} />;
    case "finished": return <CheckCircle2 data-slot="task-mark" aria-hidden className={cn(mark, "text-faint")} />;
    case "stopped": return <Square data-slot="task-mark" aria-hidden className="size-3 shrink-0 fill-current text-faint" />;
    case "failed": return <CircleAlert data-slot="task-mark" aria-hidden className={cn(mark, "text-red")} />;
    case "interrupted": return <CircleAlert data-slot="task-mark" aria-hidden className={cn(mark, "text-faint")} />;
  }
}

/** How long a task has run: counting while it runs, the length of its run
 *  once ended, nothing before it started (a queued task has no clock). */
export function TaskClock({ task, slot, className, prefix = "" }: { task: BackgroundTaskDto; slot: string; className?: string; prefix?: string }) {
  return task.status === "running"
    ? <RunningTaskClock task={task} slot={slot} className={className} prefix={prefix} />
    : <ClockText ms={taskRunMs(task, 0)} slot={slot} className={className} prefix={prefix} />;
}

function RunningTaskClock({ task, ...rest }: { task: BackgroundTaskDto; slot: string; className?: string; prefix: string }) {
  const now = useSecondClock();
  return <ClockText ms={taskRunMs(task, now)} {...rest} />;
}

function ClockText({ ms, slot, className, prefix }: { ms: number | null; slot: string; className?: string; prefix: string }) {
  if (ms === null) return null;
  return <span data-slot={slot} className={className}>{prefix}{formatElapsedClock(ms)}</span>;
}

/** Stop, for a running or queued task: a queued one never starts; files a
 *  running one already changed stay as they are. Named for its task
 *  ("Stop <title>"), as several sit in one list. A refusal says why in a
 *  toast. */
export function StopTaskButton({ task, variant }: { task: BackgroundTaskDto; variant: "icon" | "text" | "sheet" }) {
  const stop = useBackgroundTasksStore((s) => s.stop);
  // The store's: a row drawn anew (its task moved to another section) still
  // knows its Stop is on its way.
  const stopping = useBackgroundTasksStore((s) => s.stopping.has(task.id));
  const label = `Stop ${task.title}`;
  const onClick = async () => {
    if (stopping) return;
    const reason = await stop(task.id);
    if (reason) toast.error(`Couldn't stop “${task.title}”: ${reason}`);
  };
  if (variant === "text") {
    return (
      <Button variant="ghost" size="sm" data-slot="task-stop" aria-label={label} disabled={stopping} onClick={() => void onClick()} className="h-7 shrink-0 gap-1.5 px-2 text-xs text-chrome hover:text-foreground pointer-coarse:h-11">
        <Square className="size-3 fill-current" />
        Stop
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      data-slot="task-stop"
      aria-label={label}
      title="Stop"
      disabled={stopping}
      onClick={() => void onClick()}
      className={cn("shrink-0 text-chrome hover:text-foreground", variant === "sheet" ? "size-11" : "size-6 pointer-coarse:size-11")}
    >
      <Square className={cn("fill-current", variant === "sheet" ? "size-4" : "size-3")} />
    </Button>
  );
}

/** A phone sheet's ×, for what holds a task's steps or its list to pass as
 *  `close`, so it sits at the end of the one header row. */
export function SheetCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Close" onClick={onClick} className={SHEET_BUTTON}>
      <X className="size-5" />
    </button>
  );
}

/** Where it stands: Running and its clock; Queued; or how it ended, how long
 *  it ran and when it ended. */
function TaskStatusLine({ task }: { task: BackgroundTaskDto }) {
  // Whether it ended today: the clock that ages labels, not a read per render.
  const now = useNow();
  const line = "max-w-full truncate text-2xs text-faint";
  if (task.status === "running") {
    return (
      <span data-slot="task-steps-status" className={line}>
        Running<TaskClock task={task} slot="task-steps-clock" className="tabular-nums" prefix=" · " />
      </span>
    );
  }
  const ms = taskRunMs(task, 0);
  const parts = [
    taskOutcomeLabel(task),
    ms === null ? "" : formatElapsedClock(ms),
    task.status === "queued" ? "" : doneTimeLabel(task, now)
  ];
  return <span data-slot="task-steps-status" className={cn(line, task.status === "failed" && "text-red")}>{parts.filter(Boolean).join(" · ")}</span>;
}

interface TaskStepsProps {
  task: BackgroundTaskDto;
  /** ‹ before the title, back to what listed it (the Background tasks list). */
  onBack?: () => void;
  /** What closes what holds it, drawn at the header row's end: a phone
   *  sheet's × (SheetCloseButton), so ‹, the title, Stop and × are one row. */
  close?: ReactNode;
}

/** A background task (a subagent, today) where the reader opened it: a
 *  header with what it is, its job, where it stands and Stop while it can be
 *  stopped; then what it was asked (Task, folded to a few lines), the step it
 *  is on while it runs, its steps folded as one row ("Steps · N"), and what
 *  it answered (Result). Its brief and reply are its detail, read when shown;
 *  its steps are its conversation, read only once opened. On a desktop a
 *  step opens its details in place; in a phone's sheet a step opens them in
 *  the sheet, with ‹ back to the steps, and Esc (the phone's Back with it)
 *  steps back as ‹ does before it closes the sheet. Read only: nothing is
 *  sent to it. */
export function TaskSteps({ task, onBack, close }: TaskStepsProps) {
  const sheet = useIsMobile();
  const { detail, error: detailError, retry: retryDetail } = useTaskDetail(task);
  const refreshError = useCommandOutputRefresh(task);
  const [stepsOpen, setStepsOpen] = useState(false);
  // Folded again, its steps stay until they have folded away (Fold's onClosed).
  const [stepsLeaving, setStepsLeaving] = useState(false);
  const stepsShown = stepsOpen || stepsLeaving;
  // Its conversation is read only once its steps are opened.
  const { thread, error: readError, retry, olderError, retryOlder } = useSubagentConversation(stepsShown ? task.childThreadId : null, { whole: true });
  const rows = useMemo(() => (stepsShown ? taskStepRows(thread) : []), [stepsShown, thread]);
  const names = useMemo(() => {
    const results = new Map<string, ToolResultSpec>();
    for (const row of rows) if (row.result) results.set(row.call.toolCallId, row.result);
    return collectToolNames(rows.map((row) => row.call), results);
  }, [rows]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shownStep = sheet ? rows.find((row) => row.call.toolCallId === selectedId) ?? null : null;
  // Heard on the window, before the sheet hears Esc on the document, and
  // cancelled, which the sheet takes as handled: Esc steps back from a step's
  // details to the steps first.
  useEffect(() => {
    if (!shownStep) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setSelectedId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shownStep]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string, next: boolean) => setOpen((current) => {
    const copy = new Set(current);
    if (next) copy.add(id);
    else copy.delete(id);
    return copy;
  });
  const back = shownStep
    ? { label: "All steps", go: () => setSelectedId(null) }
    : onBack ? { label: "All background tasks", go: onBack } : null;
  // In a sheet the title is centred: each end holds as many 44px places.
  const header = (
    <div data-slot="task-steps-header" className={cn("flex", sheet ? "items-center gap-1" : "items-start gap-2")}>
      {back ? (
        sheet
          ? <button type="button" aria-label={back.label} onClick={back.go} className={SHEET_BUTTON}><ChevronLeft className="size-5" /></button>
          : <Button variant="ghost" size="icon" aria-label={back.label} onClick={back.go} className="size-7 shrink-0 pointer-coarse:size-11"><ChevronLeft className="size-4" /></Button>
      ) : sheet && <span aria-hidden className="size-11 shrink-0" />}
      {sheet && close && <span aria-hidden className="size-11 shrink-0" />}
      <div className={cn("flex min-w-0 flex-1 flex-col", sheet && "items-center")}>
        <span data-slot="task-steps-title" className="max-w-full truncate text-sm">
          <span className="font-medium text-foreground">{taskKindLabel(task)}</span>
          <span className="text-muted-foreground"> · {task.title}</span>
        </span>
        <TaskStatusLine task={task} />
      </div>
      {taskOpen(task) ? <StopTaskButton task={task} variant={sheet ? "sheet" : "text"} /> : sheet && <span aria-hidden className="size-11 shrink-0" />}
      {close}
    </div>
  );
  const inset = sheet ? "px-2" : undefined;
  const ended = !taskOpen(task);
  // How many calls it made: counted live once its steps are read, else as
  // its detail read it (for one still running, that count would go stale).
  const stepCount = stepsShown && thread?.loaded ? rows.length : ended ? detail?.stepCount ?? null : null;
  const reply = ended ? detail?.reply?.trim() ?? "" : "";
  if (task.kind === "command") {
    return (
      <div data-slot="task-steps" data-status={task.status} className="flex min-w-0 flex-col gap-2">
        {header}
        <CommandBody task={task} detail={detail} error={detailError} refreshError={refreshError} retry={retryDetail} className={inset} />
      </div>
    );
  }
  const body = shownStep ? (
    <ToolCallDetails row={shownStep} className="px-2 pb-2" layout="sheet" />
  ) : (
    <>
      <section data-slot="task-brief" className={cn("flex flex-col gap-1", inset)}>
        <span className={SECTION_HEAD}>Task</span>
        {detail && <BriefText text={detail.brief} />}
        {/* Read before it moved on, what it was asked stays; what it answered waits for Retry. */}
        {detailError ? <InlineError detail={detailError} onRetry={retryDetail}>Couldn't load the task.</InlineError>
          : !detail && <LoadingLine className="text-xs" />}
      </section>
      {task.status === "running" && <TaskStepLine task={task} className={inset} />}
      {task.status === "queued" && <p data-slot="task-queued" className={cn("text-xs text-muted-foreground", inset)}>{QUEUED_NOTE}</p>}
      {task.status !== "queued" && (
        <section data-slot="task-steps-section" className="flex flex-col">
          <button
            type="button"
            data-slot="task-steps-toggle"
            aria-expanded={stepsOpen}
            onClick={() => {
              if (stepsOpen) setStepsLeaving(true);
              setStepsOpen(!stepsOpen);
            }}
            className="flex min-h-8 items-center gap-1.5 rounded-sm px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-sel pointer-coarse:min-h-11"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", stepsOpen && "rotate-90")} />
            <span className="font-medium text-foreground">Steps</span>
            {stepCount !== null && <span data-slot="task-steps-count" className="num text-faint">· {stepCount}</span>}
          </button>
          <Fold open={stepsOpen} onClosed={() => setStepsLeaving(false)} className="flex flex-col">
              {!thread?.loaded && (readError
                ? <InlineError detail={readError} onRetry={retry} className={inset}>Couldn't load its steps.</InlineError>
                : <LoadingLine className={cn("text-xs", inset)} />)}
              {olderError && <InlineError detail={olderError} onRetry={retryOlder} className={inset}>Couldn't load its earlier steps.</InlineError>}
              {rows.length > 0 && (sheet
                ? <div data-slot="task-steps-list" className="flex flex-col"><ToolCallSheetRows rows={rows} onSelect={setSelectedId} /></div>
                : <ToolCallRows rows={rows} open={open} onToggle={toggle} />)}
          </Fold>
        </section>
      )}
      {task.status === "failed" && task.error && (
        <p data-slot="task-error" className={cn("text-xs text-red [overflow-wrap:anywhere]", inset)}>{formatUserFacingError(task.error)}</p>
      )}
      {reply && (
        <section data-slot="task-reply" className={cn("flex flex-col gap-1", inset)}>
          <span className={SECTION_HEAD}>Result</span>
          <MarkdownView text={reply} dense />
        </section>
      )}
    </>
  );
  return (
    <ToolNamesContext.Provider value={names}>
      <div data-slot="task-steps" data-status={task.status} className="flex min-w-0 flex-col gap-2">
        {header}
        {body}
      </div>
    </ToolNamesContext.Provider>
  );
}

/** A section's name in a task's detail: Task, Result; a command's Command, Output. */
const SECTION_HEAD = "label-micro text-faint";

/** How often a running command's open detail reads its output again. */
const COMMAND_DETAIL_REFRESH_MS = 2000;

/** While a command runs and its detail is open, its output is read again
 *  every COMMAND_DETAIL_REFRESH_MS. Why the latest read failed, until one
 *  works again; null for none. */
function useCommandOutputRefresh(task: Pick<BackgroundTaskDto, "id" | "kind" | "status">): string | null {
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  useEffect(() => {
    if (task.kind !== "command" || task.status !== "running") return;
    let live = true;
    const timer = setInterval(() => {
      useBackgroundTasksStore.getState().loadDetail(task.id).then(
        () => { if (live) setFailure(null); },
        (err: unknown) => { if (live) setFailure({ id: task.id, message: errorText(err) }); }
      );
    }, COMMAND_DETAIL_REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [task.id, task.kind, task.status]);
  return failure && failure.id === task.id && task.status === "running" ? failure.message : null;
}

/** A command's detail below its header: what it runs (Command), the end of
 *  its output as it is now (Output: long lines scroll sideways, never wrap),
 *  and how much of it that is and where all of it is. */
function CommandBody({ task, detail, error, refreshError, retry, className }: {
  task: BackgroundTaskDto;
  detail: ReturnType<typeof useTaskDetail>["detail"];
  /** Why its detail could not be read, shown over what was read before. */
  error: string | null;
  /** Why its latest re-read failed while it runs. */
  refreshError: string | null;
  retry: () => void;
  className?: string;
}) {
  const output = detail?.reply ?? "";
  const counts = detail?.output;
  const note = counts && counts.totalLines > 0
    ? `Last ${counts.shownLines.toLocaleString("en-US")} of ${counts.totalLines.toLocaleString("en-US")} lines · ${formatByteSize(counts.bytes)} · full output: ${counts.path}`
    : null;
  return (
    <>
      <section data-slot="task-command" className={cn("flex flex-col gap-1", className)}>
        <span className={SECTION_HEAD}>Command</span>
        {detail && <pre data-slot="task-command-text" className="whitespace-pre-wrap break-all rounded-md bg-sel px-2.5 py-2 font-mono text-xs leading-[1.5] text-foreground">{detail.brief || task.command}</pre>}
        {/* Read before it moved on, what was read stays; what it is now waits for Retry. */}
        {error ? <InlineError detail={error} onRetry={retry}>Couldn't load the command.</InlineError> : !detail && <LoadingLine className="text-xs" />}
      </section>
      {detail && (
        <section data-slot="task-output" className={cn("flex flex-col gap-1", className)}>
          <span className={SECTION_HEAD}>Output</span>
          {output
            ? <pre data-slot="task-output-text" className="max-h-[320px] overflow-auto whitespace-pre rounded-md border border-border-soft bg-panel px-2.5 py-2 font-mono text-xs leading-[1.5] text-muted-foreground">{output}</pre>
            : <p data-slot="task-output-empty" className="text-xs text-faint">No output yet.</p>}
          {note && <p data-slot="task-output-note" className="text-2xs text-faint [overflow-wrap:anywhere]">{note}</p>}
          {refreshError && <p data-slot="task-output-error" className="text-2xs text-red [overflow-wrap:anywhere]">{`Couldn't load its output. ${refreshError}`}</p>}
        </section>
      )}
      {/* Killed by a signal it was not sent by Mandate: why, as recorded (an exit says itself in the status line). */}
      {task.status === "failed" && task.exitCode === null && task.error && (
        <p data-slot="task-error" className={cn("text-xs text-red [overflow-wrap:anywhere]", className)}>{formatUserFacingError(task.error)}</p>
      )}
    </>
  );
}

/** What it was asked: a few lines until opened, then as written (Markdown).
 *  Whether it is longer is measured, since a line's length depends on the
 *  width it has. */
function BriefText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [opened, setOpened] = useState(false);
  const [longer, setLonger] = useState(false);
  const plain = useMemo(() => markdownToText(text), [text]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || opened) return;
    const measure = () => setLonger(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [plain, opened]);
  return (
    <div className="flex flex-col gap-1">
      {opened
        ? <div data-slot="task-brief-text" className="text-sm"><MarkdownView text={text} dense /></div>
        : <p ref={ref} data-slot="task-brief-text" className="line-clamp-4 whitespace-pre-wrap text-sm leading-[1.55] [overflow-wrap:anywhere]">{plain}</p>}
      {(longer || opened) && (
        <button
          type="button"
          data-slot="task-brief-fold"
          aria-expanded={opened}
          onClick={() => setOpened((was) => !was)}
          className="hit relative self-start rounded-xs text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {opened ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** A running task's step, as one line, as its line in the transcript says it. */
function TaskStepLine({ task, className }: { task: BackgroundTaskDto; className?: string }) {
  const step = useTaskStep(task);
  return (
    <p data-slot="task-step-now" className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <WorkingGlyph />
      <span data-slot="task-step-text" className="min-w-0 truncate text-shimmer">{step ?? "Working"}…</span>
    </p>
  );
}

/** A task's steps where the reader asked for them: a box at what opened them
 *  on a desktop (on its `side`), the sheet on a phone. Nothing in the
 *  transcript moves: it is not scrolled to where the task started, and no run
 *  in it opens (which would stop it following). */
export function TaskStepsPeek({ task, side, trigger, onOpenChange, focusFallback }: {
  task: BackgroundTaskDto;
  side: "top" | "bottom";
  /** The control that opens it, given what it needs to. */
  trigger: (props: { onClick?: () => void; "aria-haspopup"?: "dialog"; ref?: Ref<HTMLButtonElement> }) => ReactElement;
  /** Its steps opened or closed. */
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes when they close and the control they opened from is
   *  gone (the strip's row drawn anew as they closed). */
  focusFallback?: (options: { composer: boolean }) => HTMLElement | null;
}) {
  const phone = useIsMobile();
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Closed by Esc: focus is given on. Closed otherwise, it stays where
  // that close put it (a press elsewhere keeps the focus it gave).
  const closedByEscape = useRef(false);
  useCloseWhenCovered(open, () => change(false));
  const name = `${taskKindLabel(task)} · ${task.title}`;
  if (phone) {
    return (
      <>
        {trigger({ onClick: () => change(true), "aria-haspopup": "dialog", ref: triggerRef })}
        <BottomSheet
          open={open}
          onOpenChange={change}
          slot="task-steps-sheet"
          // Back to what opened it, or what replaced it (not the composer: a
          // keyboard would rise).
          returnFocus={() => (triggerRef.current?.isConnected ? triggerRef.current : focusFallback?.({ composer: false }) ?? null)}
          header={<BottomSheetTitle className="sr-only">{name}</BottomSheetTitle>}
          bodyClassName="px-2 pb-4"
        >
          <TaskSteps task={task} close={<SheetCloseButton onClick={() => change(false)} />} />
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>{trigger({ ref: triggerRef })}</PopoverTrigger>
      {/* As tall as the window leaves it on its side, so it flips from a line
          low on the page and never leaves the window. */}
      <PopoverContent
        data-slot="task-steps-popover"
        aria-label={name}
        onEscapeKeyDown={() => { closedByEscape.current = true; }}
        // Its control drawn anew as it closed (the strip folding): focus goes
        // to what replaced it, not to nothing.
        onCloseAutoFocus={(event) => {
          const byEscape = closedByEscape.current;
          closedByEscape.current = false;
          if (byEscape && !triggerRef.current?.isConnected && focusFallback) {
            event.preventDefault();
            focusFallback({ composer: true })?.focus();
          }
        }}
        side={side}
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-[min(40rem,var(--radix-popover-content-available-height))] w-[min(35rem,calc(100vw-2rem))] flex-col overflow-y-auto p-3"
      >
        <TaskSteps task={task} />
      </PopoverContent>
    </Popover>
  );
}
