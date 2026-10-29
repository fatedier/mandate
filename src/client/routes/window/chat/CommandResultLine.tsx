import { memo } from "react";
import type { CommandResultMetadata } from "@shared/command-messages";
import { formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TaskMark } from "./TaskSteps";
import { commandOutcomeLabel, commandOutcomeStatus, taskKindLabel } from "./background-tasks-view";

/** A background command's end where it landed in the conversation that
 *  started it: one line, what it is, its description, how it ended and how
 *  long it ran, marked as it ended. Its output is not drawn: the line where
 *  it started opens it. Drawn from what the result records (its metadata);
 *  the message's text is what the model reads. Not the user's words: it is
 *  what the agent's next turn answers. */
function CommandResultLineImpl({ result }: { result: CommandResultMetadata }) {
  const status = commandOutcomeStatus(result);
  const duration = result.durationMs > 0 ? formatElapsedClock(result.durationMs) : "";
  return (
    <div data-slot="command-result" data-outcome={result.outcome} className="my-1 flex min-w-0 items-center gap-2">
      <TaskMark task={{ status }} />
      <span data-slot="command-result-head" className="min-w-0 truncate text-xs text-muted-foreground">
        <span className="text-foreground">{taskKindLabel({ kind: "command" })}</span>
        {` · ${result.title}`}
        <span className={cn(status === "failed" && "text-red")}>{` · ${commandOutcomeLabel(result)}`}</span>
        {duration && ` · ${duration}`}
      </span>
    </div>
  );
}

export const CommandResultLine = memo(CommandResultLineImpl);
