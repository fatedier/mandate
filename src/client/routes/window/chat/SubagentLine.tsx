import type { ComponentProps } from "react";
import { ChevronRight, CircleDot } from "lucide-react";
import type { BackgroundTaskDto, BackgroundTaskKind, SubagentType } from "@shared/api-contracts";
import { cn } from "@/lib/utils";
import { useBackgroundTask } from "@/store/background-tasks";
import { TaskClock, TaskMark, TaskStepsPeek } from "./TaskSteps";
import { taskKindLabel } from "./background-tasks-view";
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
export function SubagentLine({ threadId, taskId, title, kind = "subagent", type }: {
  /** The conversation it was started from, whose tasks hold it. */
  threadId: string;
  taskId: string;
  /** As its call named it, until the task is read. */
  title: string;
  /** As its call says, until the task is read. */
  kind?: BackgroundTaskKind;
  /** A subagent's type, as its call says, until the task is read. */
  type?: SubagentType;
}) {
  // Its conversation's copy, or, older than the pages its list has read, one read by its id.
  const task = useBackgroundTask(threadId, taskId);
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
  return <TaskStepsPeek task={task} side="bottom" trigger={(props) => <SubagentLineButton task={task} {...props} />} />;
}

function SubagentLineButton({ task, ...props }: { task: BackgroundTaskDto } & ComponentProps<"button">) {
  const running = task.status === "running";
  // Running, it reads no step: the strip says that.
  const state = useTaskState(task, !running);
  return (
    <button {...props} type="button" data-slot="subagent-line" data-status={task.status} className={cn(LINE, "transition-colors hover:bg-sel hover:text-foreground")}>
      {running ? <CircleDot data-slot="task-mark" aria-hidden className="size-3.5 shrink-0 text-chrome" /> : <TaskMark task={task} />}
      {/* A long job gives way; the clock does not. */}
      <span data-slot="subagent-line-text" className="min-w-0 truncate">
        <span className="text-foreground">{taskKindLabel(task)}</span>
        {" · "}{task.title}
        <span data-slot="subagent-line-state" className={cn(task.status === "failed" && "text-red")}>
          {" · "}{running ? "Running" : state}
        </span>
      </span>
      {!running && <TaskClock task={task} slot="subagent-line-clock" className="shrink-0 whitespace-nowrap tabular-nums text-faint" prefix="· " />}
      <ChevronRight aria-hidden className="size-3 shrink-0 text-faint" />
    </button>
  );
}
