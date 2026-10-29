import { memo } from "react";
import type { SubagentResultMetadata } from "@shared/subagent-messages";
import { MarkdownView } from "@/components/MarkdownView";
import { formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TaskMark } from "./TaskSteps";
import { taskKindLabel, taskOutcomeLabel } from "./background-tasks-view";

/** A subagent's result where it landed in the conversation that started it,
 *  as a worker's report is: what it is, its job, how it ended and how long it
 *  took (and why, when it failed); then its reply to the agent, as written
 *  (Markdown). Drawn from what
 *  the result records (its metadata) alone: the message's text is what the
 *  model reads, and is never drawn. Not the user's words; it is what the
 *  agent's next turn answers (that turn draws no cause line of its own). */
function SubagentResultCardImpl({ result }: { result: SubagentResultMetadata }) {
  const reply = result.reply?.trim() ?? "";
  // Why it failed, as its run recorded it: the head says only that it did.
  const reason = result.outcome === "failed" ? result.error?.trim() ?? "" : "";
  const duration = result.durationMs > 0 ? formatElapsedClock(result.durationMs) : "";
  return (
    // No clock on the card: the dividers show the time, the row's own shows
    // on hover (RowFrame).
    <div data-slot="subagent-result" data-outcome={result.outcome} className="my-2 rounded-lg border border-border-soft bg-panel px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <TaskMark task={{ status: result.outcome }} />
        <span data-slot="subagent-result-head" className="min-w-0 truncate text-xs text-muted-foreground">
          <span className="text-foreground">{taskKindLabel({ kind: "subagent" })}</span>
          {` · ${result.title}`}
          <span className={cn(result.outcome === "failed" && "text-red")}>{` · ${taskOutcomeLabel({ status: result.outcome })}`}</span>
          {duration && ` · ${duration}`}
        </span>
      </div>
      {reason && <div data-slot="subagent-result-error" className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{reason}</div>}
      {reply && <div data-slot="subagent-result-reply" className="mt-1.5"><MarkdownView text={reply} dense /></div>}
    </div>
  );
}

export const SubagentResultCard = memo(SubagentResultCardImpl);
