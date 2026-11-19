import { memo } from "react";
import { ChevronRight } from "lucide-react";
import type { SubagentResultMetadata } from "@shared/subagent-messages";
import { MarkdownView } from "@/components/MarkdownView";
import { ReplyPeek } from "@/components/ReplyPeek";
import { formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TaskMark } from "./TaskSteps";
import { taskKindLabel, taskOutcomeLabel } from "./background-tasks-view";

/** A subagent's result where it landed in the conversation that started it:
 *  one line, what it is, its job, how it ended and how long it took. Its
 *  reply (or why it failed) opens from the line, in a box at it — on a phone,
 *  the sheet — as a worker's reply does on Personal agent's page: the user talks
 *  to the agent, which answers from it in its next turn (that turn draws no
 *  cause line of its own). Drawn from what the result records (its
 *  metadata) alone: the message's text is what the model reads, and is never
 *  drawn. A result with nothing to show is the line alone. */
function SubagentResultCardImpl({ result }: { result: SubagentResultMetadata }) {
  const reply = result.reply?.trim() ?? "";
  // Why it failed, as its run recorded it: the line says only that it did.
  const reason = result.outcome === "failed" ? result.error?.trim() ?? "" : "";
  const duration = result.durationMs > 0 ? formatElapsedClock(result.durationMs) : "";
  const kind = taskKindLabel({ kind: "subagent" });
  const outcome = taskOutcomeLabel({ status: result.outcome });
  const line = (
    <>
      <TaskMark task={{ status: result.outcome }} />
      <span data-slot="subagent-result-head" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        <span className="text-foreground">{kind}</span>
        {` · ${result.title}`}
        <span className={cn(result.outcome === "failed" && "text-destructive")}>{` · ${outcome}`}</span>
        {duration && ` · ${duration}`}
      </span>
    </>
  );
  // No clock on the line: the dividers show the time, the row's own shows
  // on hover (RowFrame).
  const frame = "flex w-full min-w-0 items-center gap-2 rounded-lg border border-border-soft bg-panel px-3 py-2.5";
  if (!reply && !reason) {
    return <div data-slot="subagent-result" data-outcome={result.outcome} className={cn("my-2", frame)}>{line}</div>;
  }
  return (
    <div data-slot="subagent-result" data-outcome={result.outcome} className="my-2">
      <ReplyPeek
        slot="subagent-reply"
        title={result.title}
        state={[kind, outcome, duration].filter(Boolean).join(" · ")}
        body={(
          <>
            {reason && <p data-slot="subagent-result-error" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{reason}</p>}
            {reply && <div data-slot="subagent-result-reply" className={cn(reason && "mt-2")}><MarkdownView text={reply} dense /></div>}
          </>
        )}
        trigger={(props) => (
          <button
            type="button"
            data-slot="subagent-result-open"
            className={cn(frame, "text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11")}
            {...props}
          >
            {line}
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        )}
      />
    </div>
  );
}

export const SubagentResultCard = memo(SubagentResultCardImpl);
