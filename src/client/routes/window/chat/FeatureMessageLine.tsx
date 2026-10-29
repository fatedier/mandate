import { useMemo, useState } from "react";
import { ChevronRight, CircleAlert, CircleStop, MessageSquare, Send, type LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { AgentMessage } from "@/store/agent-chat";
import { formatDateTime, formatDateTimeTitle } from "@/lib/format";
import { featureMessageMetadata, type FeatureReplyOutcome } from "@shared/feature-message";
import { formatUserFacingError } from "@/lib/error-message";
import { MarkdownView } from "@/components/MarkdownView";
import { markdownToText } from "@/lib/markdown-text";
import { useGlobalAgentStore } from "@/store/global-agent";
import { displayGlobalAgentName } from "@shared/global-agent-name";

/**
 * A feature reply is not a summary of what the worker did — it is that
 * agent's whole closing turn, forwarded up to 20k characters
 * (REPLY_MAX_CHARS in feature-message-relay.ts) and written for another agent
 * to read.
 *
 * Every other machine-authored row here is a single line: watch, alarm and
 * runtime-context all go through SystemMessage, which
 * truncates, so an 8.5k-character runtime context still occupies one. This row
 * wore the same header — mono label, name, right-aligned clock — and then
 * unfolded several screens of markdown underneath, which is why it read as a
 * context line that had somehow grown a body.
 *
 * So it summarises and opens: the shape CompressionSummaryMessage already uses
 * for the other block of generated prose in this transcript.
 */

/** Past this a reply no longer fits the row at the dock's 480px default, so
 *  showing it inline would truncate away its own tail with nothing offering
 *  the rest. */
const INLINE_MAX_CHARS = 100;

/** A line of a worker's markdown as the words it says. A reply is written
 *  for another agent, in markdown; shown as written, its first line read
 *  "**Merged**" and "[PR #12](https://…)". A line of markup with no
 *  words in it (a bare fence) stays as written: an empty row says less. */
function plainLine(line: string): string {
  return markdownToText(line) || line;
}

/** A turn that left no words for its manager: the row says what
 *  happened, in the transcript's ordinary colours. The red belongs to the
 *  turn that failed, in the worker's own chat, and to the worker's card. */
const ENDED: Record<FeatureReplyOutcome, { label: string; icon: LucideIcon; reason: string }> = {
  error: { label: "Worker failed", icon: CircleAlert, reason: "Its turn ended in an error." },
  canceled: { label: "Worker interrupted", icon: CircleStop, reason: "Its turn was interrupted before it replied." },
  stuck: { label: "Worker stopped", icon: CircleStop, reason: "The same call kept failing." },
  no_reply: { label: "Worker finished", icon: MessageSquare, reason: "Its turn ended without a text reply." }
};

/** The reason alone: what the turn gave for a failure or a repeated failing
 *  call, read as the turn's own Failed line reads an error (its message, one
 *  line, a bounded length), else the ending's own words. The sentence stored
 *  as the message's text is for the manager's model. */
function endedReason(outcome: FeatureReplyOutcome, detail: string | undefined): string {
  return detail ? formatUserFacingError(detail) : ENDED[outcome].reason;
}

export function FeatureMessageLine({ message, named }: {
  message: AgentMessage;
  /** The thread has more than one worker, so the header says whose reply
   *  this is; with one, the name would repeat on every reply. */
  named: boolean;
}) {
  const [open, setOpen] = useState(false);
  const agent = useGlobalAgentStore((s) => s.agent);
  const content = message.content.type === "text" ? message.content : null;
  const metadata = content ? featureMessageMetadata(content) : null;
  // What the user told the worker, copied to its manager: this
  // row's shape, the user's own words rather than the text the model reads,
  // and via whom when it went through the user's agent.
  const note = metadata?.direction === "note";
  const ended = metadata?.outcome ?? null;
  const text = (note ? metadata?.text ?? "" : ended ? endedReason(ended, metadata?.detail) : content?.text ?? "").trim();
  // The row's one line. A note is the user's own words and stays as typed; a
  // reply's line is read as text. Parsed once per reply: the transcript
  // redraws on every streamed delta.
  const line = useMemo(() => {
    const first = text.split("\n", 1)[0]?.trim() ?? "";
    return note ? first : plainLine(first);
  }, [text, note]);

  if (!content) return null;
  const featureLabel = metadata?.featureName || metadata?.featureId || "Worker";
  const absoluteTime = formatDateTimeTitle(message.createdAt);
  const slot = note ? "worker-note" : "worker-reply";
  const via = note && metadata?.by === "agent" ? `via ${agent?.named ? displayGlobalAgentName(agent.name) : "your agent"}` : null;
  const Icon = note ? Send : ended ? ENDED[ended].icon : MessageSquare;
  const label = note ? "You told the worker" : ended ? ENDED[ended].label : "Worker replied";

  // A reply already short enough to read in place has nothing behind it, and
  // an affordance onto an empty room is worse than no affordance. A reason is
  // no reply to open: it is shown whole, on as many lines as it takes.
  const hasMore = !ended && (text.includes("\n") || text.length > INLINE_MAX_CHARS);

  // No clock in the header: the transcript's dividers show the time, the row's
  // own shows on hover (RowFrame), and the reply's dialog says it in full.
  const header = (
    <div className="flex items-center gap-2 text-2xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="shrink-0 font-medium text-chrome">{label}</span>
      {named && <span className="min-w-0 truncate">{featureLabel}</span>}
      {via && <span className="shrink-0 text-faint">{via}</span>}
    </div>
  );

  // Both shapes are one size, the transcript's dense machine-row size.
  if (!hasMore) {
    return (
      <div data-slot={slot} data-outcome={ended ?? undefined} className="my-1 flex flex-col gap-1 border-l border-border/70 pl-2">
        {header}
        {/* Shown whole: a reply's one line, or a reason as given. */}
        <div data-slot={`${slot}-body`} className="break-words text-xs text-foreground/90">{ended ? text : line}</div>
      </div>
    );
  }

  return (
    <>
      <div data-slot={slot} className="my-1 flex flex-col gap-0.5 border-l border-border/70 pl-2">
        {header}
        {/* View reply follows the summary, as a cause line's chevron follows
            its text, instead of waiting at the column's far end. */}
        <button
          type="button"
          data-slot={`${slot}-body`}
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-xs py-0.5 text-left text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11"
        >
          <span data-slot={`${slot}-summary`} className="min-w-0 truncate text-foreground/90">{line}</span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-medium text-muted-foreground">
            {note ? "View message" : "View reply"}
            <ChevronRight className="size-3" aria-hidden="true" />
          </span>
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border-soft px-5 py-4">
            <DialogTitle className="text-base">{featureLabel}</DialogTitle>
            <DialogDescription>
              {note ? "What you told the worker." : "Reply from the worker."}
              {absoluteTime && (
                <time data-slot="dialog-time" className="ml-2 tabular-nums" dateTime={message.createdAt} title={absoluteTime}>
                  {formatDateTime(message.createdAt)}
                </time>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto px-5 py-4 text-sm">
            <MarkdownView text={text} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
