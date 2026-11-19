import { memo, type ReactNode } from "react";
import { SquareTerminal } from "lucide-react";
import type { CommandResultMetadata } from "@shared/command-messages";
import { formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBackgroundTask } from "@/store/background-tasks";
import { TaskStepsPeek } from "./TaskSteps";
import { commandOutcomeLabel, commandOutcomeStatus } from "./background-tasks-view";

/** A background command's end where it landed in the conversation that
 *  started it, once the turn that started it was over: it woke the turn under
 *  it, so it reads as that turn's cause, as a pane's change or an alarm does
 *  (ChatProvenanceLine's look), smaller and fainter than the line where the
 *  command started, so it is not taken for a second run. Its description,
 *  ended, how it ended and how long it ran. Its output is not drawn: pressed,
 *  it opens what its start line opens, once its task is read. Drawn from what
 *  the result records (its metadata); the message's text is what the model
 *  reads. Not the user's words: it is what the agent's next turn answers. */
function CommandResultLineImpl({ threadId, result }: { threadId: string; result: CommandResultMetadata }) {
  const task = useBackgroundTask(threadId, result.taskId);
  const status = commandOutcomeStatus(result);
  const duration = result.durationMs > 0 ? formatElapsedClock(result.durationMs) : "";
  const body: ReactNode = (
    <>
      <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
      {/* The description keeps its width as long as it can; how it ended
          gives way first. */}
      <span className="flex min-w-0 items-center">
        <span data-slot="command-result-title" className="min-w-0 truncate font-medium text-chrome group-hover/cause:underline">{result.title}</span>
        <span className="min-w-0 truncate whitespace-pre">
          {" · ended · "}
          <span data-slot="command-result-outcome" className={cn(status === "failed" && "text-destructive")}>{commandOutcomeLabel(result)}</span>
          {duration && ` · ${duration}`}
        </span>
      </span>
    </>
  );
  return (
    <div
      data-slot="command-result"
      data-outcome={result.outcome}
      className={cn("my-0.5 flex h-6 min-w-0 items-center gap-2 px-1 text-2xs text-faint", task && "pointer-coarse:h-11")}
    >
      {task ? (
        <TaskStepsPeek
          task={task}
          side="bottom"
          trigger={(props) => (
            <button
              {...props}
              type="button"
              className="group/cause flex min-w-0 items-center gap-2 rounded-xs text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11"
            >
              {body}
            </button>
          )}
        />
      ) : body}
    </div>
  );
}

export const CommandResultLine = memo(CommandResultLineImpl);
