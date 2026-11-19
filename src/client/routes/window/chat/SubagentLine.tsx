import { useEffect, useRef, useState, type ComponentProps, type Ref } from "react";
import { ChevronRight, CircleDot, Layers } from "lucide-react";
import type { BackgroundTaskDto, BackgroundTaskKind, SubagentType } from "@shared/api-contracts";
import { Fold } from "@/components/Fold";
import { cn } from "@/lib/utils";
import { useBackgroundTask, useBackgroundTasksById } from "@/store/background-tasks";
import { TaskClock, TaskMark, TaskStepsPeek } from "./TaskSteps";
import { endedCommandsLabel, taskKindLabel } from "./background-tasks-view";
import { arrangeTaskLines, endedOpenKey, peekingCalls, peekOpenKey, type StartedTaskLine } from "./subagent-lines";
import { useTaskState } from "./useTaskStep";

/** As a run's line: a quiet line of the transcript's furniture. */
const LINE = "-ml-1.5 flex min-h-7 max-w-full items-center gap-1.5 self-start rounded-sm px-1.5 py-0.5 text-left text-xs text-muted-foreground pointer-coarse:min-h-11";

/** A background task where it started (a subagent, a command in the
 *  background): one line out of its run, as a question's line is: what kind
 *  it is, its job, and Running, Queued, or how it ended and how long it ran.
 *  While it runs its progress (the step it is on, its clock, Stop) is on the
 *  strip above the composer, not here too: this line marks where it began,
 *  still. A click opens its steps where the line is (TaskStepsPeek); nothing
 *  in the transcript moves. Until the page has read its task the line names
 *  the job alone. */
export function SubagentLine({ threadId, taskId, title, kind = "subagent", type, kindShown = true, onPeekChange, focusFallback }: {
  /** The conversation it was started from, whose tasks hold it. */
  threadId: string;
  taskId: string;
  /** As its call named it, until the task is read. */
  title: string;
  /** As its call says, until the task is read. */
  kind?: BackgroundTaskKind;
  /** A subagent's type, as its call says, until the task is read. */
  type?: SubagentType;
  /** False in the ended commands' line, which says what they are. */
  kindShown?: boolean;
  /** Its steps opened or closed at it. */
  onPeekChange?: (open: boolean) => void;
  /** Where focus goes when its steps close and the line is gone (folded). */
  focusFallback?: () => HTMLElement | null;
}) {
  // Its conversation's copy, or, older than the pages its list has read, one read by its id.
  const task = useBackgroundTask(threadId, taskId);
  // Its steps open, the line says so; gone while they are open (its row left
  // the page), it lets go, or its mark would keep it out of the fold.
  const peekOpen = useRef(false);
  const latestPeekChange = useRef(onPeekChange);
  useEffect(() => { latestPeekChange.current = onPeekChange; });
  useEffect(() => () => {
    if (peekOpen.current) latestPeekChange.current?.(false);
  }, []);
  if (!task) {
    return (
      <p data-slot="subagent-line" data-status="unread" className={LINE}>
        <span data-slot="subagent-line-text" className="min-w-0 truncate">
          <span className="text-foreground">{taskKindLabel({ kind, type })}</span>
          {title && ` · ${title}`}
        </span>
      </p>
    );
  }
  return (
    <TaskStepsPeek
      task={task}
      side="bottom"
      onOpenChange={(open) => {
        peekOpen.current = open;
        onPeekChange?.(open);
      }}
      focusFallback={focusFallback}
      trigger={(props) => <SubagentLineButton task={task} kindShown={kindShown} {...props} />}
    />
  );
}

function SubagentLineButton({ task, kindShown, ...props }: { task: BackgroundTaskDto; kindShown: boolean } & ComponentProps<"button">) {
  const running = task.status === "running";
  // Running, it reads no step: the strip says that.
  const state = useTaskState(task, !running);
  return (
    <button {...props} type="button" data-slot="subagent-line" data-status={task.status} className={cn(LINE, "transition-colors hover:bg-sel hover:text-foreground")}>
      {running ? <CircleDot data-slot="task-mark" aria-hidden className="size-3.5 shrink-0 text-chrome" /> : <TaskMark task={task} />}
      {/* A long job gives way; the clock does not. */}
      <span data-slot="subagent-line-text" className="min-w-0 truncate">
        {kindShown ? (
          <>
            <span className="text-foreground">{taskKindLabel(task)}</span>
            {" · "}{task.title}
          </>
        ) : <span className="text-foreground">{task.title}</span>}
        <span data-slot="subagent-line-state" className={cn(task.status === "failed" && "text-destructive")}>
          {" · "}{running ? "Running" : state}
        </span>
      </span>
      {!running && <TaskClock task={task} slot="subagent-line-clock" className="shrink-0 whitespace-nowrap tabular-nums text-faint" prefix="· " />}
      <ChevronRight aria-hidden className="size-3 shrink-0 text-faint" />
    </button>
  );
}

/** The background tasks a row started, where it started them, above its run:
 *  the run's line stays last, next to what the turn is doing now. The
 *  commands that have ended fold into one line once two or more have
 *  (arrangeTaskLines); every other task is a line of its own. */
export function StartedTaskLines({ threadId, lines, expandedIds, onExpandedChange }: {
  threadId: string;
  lines: readonly StartedTaskLine[];
  /** Which folds are open, when the list keeps that (it stops following the
   *  end while one is open). Local otherwise. */
  expandedIds?: ReadonlySet<string>;
  onExpandedChange?: (id: string, expanded: boolean) => void;
}) {
  const tasks = useBackgroundTasksById(threadId, lines.map((l) => l.taskId));
  // The folded line opened, and the lines whose steps are open where they
  // are (kept out of the fold until they close, then folded in): marks in
  // the list's set, where the follow pause reads them too, or local.
  const [localMarks, setLocalMarks] = useState<ReadonlySet<string>>(() => new Set());
  const marks = expandedIds ?? localMarks;
  const setMark = (id: string, next: boolean) => {
    if (!expandedIds) {
      setLocalMarks((current) => {
        if (current.has(id) === next) return current;
        const copy = new Set(current);
        if (next) copy.add(id);
        else copy.delete(id);
        return copy;
      });
    }
    onExpandedChange?.(id, next);
  };
  // Closed by Esc, a line folded in gives focus to the folded line.
  const foldedLine = useRef<HTMLButtonElement | null>(null);
  const { ended, single } = arrangeTaskLines(lines, tasks, peekingCalls(marks));
  return (
    <>
      {ended.length > 0 && (
        <EndedCommandsLine threadId={threadId} lines={ended} tasks={tasks} marks={marks} setMark={setMark} lineRef={foldedLine} />
      )}
      {single.map(({ callId, taskId, title, kind, type }) => (
        <SubagentLine
          key={callId}
          threadId={threadId}
          taskId={taskId}
          title={title}
          kind={kind}
          type={type}
          // Only a command folds: only its line is kept while its steps are open.
          onPeekChange={kind === "command" ? (open) => setMark(peekOpenKey(callId), open) : undefined}
          focusFallback={() => foldedLine.current}
        />
      ))}
    </>
  );
}

/** The ended commands of a row as one line: how many ended, then how many
 *  failed (in red), were stopped or were cut short. Pressed, it lists them
 *  in place, the latest to end first, each a task's line without the word
 *  Command; the line says it. Open by the mark of any of its commands, so a
 *  command that ends while it is open joins it open; folding takes them all. */
function EndedCommandsLine({ threadId, lines, tasks, marks, setMark, lineRef }: {
  threadId: string;
  lines: readonly StartedTaskLine[];
  tasks: ReadonlyMap<string, BackgroundTaskDto>;
  marks: ReadonlySet<string>;
  setMark: (id: string, open: boolean) => void;
  lineRef?: Ref<HTMLButtonElement>;
}) {
  const open = lines.some((l) => marks.has(endedOpenKey(l.callId)));
  const toggle = () => {
    if (!open) {
      setMark(endedOpenKey(lines[0]!.callId), true);
      return;
    }
    for (const l of lines) if (marks.has(endedOpenKey(l.callId))) setMark(endedOpenKey(l.callId), false);
  };
  const { head, clauses } = endedCommandsLabel(lines.flatMap((l) => tasks.get(l.taskId) ?? []));
  return (
    <div data-slot="ended-commands" className="flex min-w-0 flex-col">
      <button ref={lineRef} type="button" data-slot="ended-commands-line" aria-expanded={open} onClick={toggle} className={cn(LINE, "transition-colors hover:bg-sel hover:text-foreground")}>
        <Layers aria-hidden className="size-3.5 shrink-0 text-chrome" />
        <span data-slot="ended-commands-text" className="min-w-0 truncate">
          <span className="text-foreground">{head}</span>
          {clauses.map((clause) => (
            <span key={clause.text} data-slot="ended-commands-clause" className={cn(clause.failed && "text-destructive")}>{` · ${clause.text}`}</span>
          ))}
        </span>
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </button>
      <Fold open={open}>
        <div data-slot="ended-commands-list" className="my-0.5 ml-[7px] flex flex-col border-l border-border/70 pl-2">
          {lines.map(({ callId, taskId, title, kind }) => (
            <SubagentLine key={callId} threadId={threadId} taskId={taskId} title={title} kind={kind} kindShown={false} />
          ))}
        </div>
      </Fold>
    </div>
  );
}
