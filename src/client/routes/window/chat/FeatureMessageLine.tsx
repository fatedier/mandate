import { useState } from "react";
import { MessageSquare } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { AgentMessage } from "@/store/agent-chat";
import { formatClockTime, formatDateTimeTitle } from "@/lib/format";
import { featureMessageMetadata } from "@shared/feature-message";
import { LazyMarkdownView } from "@/components/LazyMarkdownView";

/**
 * A feature reply is not a summary of what the worker did — it is that
 * agent's whole closing turn, forwarded up to 20k characters
 * (feature-message-relay.ts:92) and written for another agent to read.
 *
 * Every other machine-authored row here is a single line: watch, alarm,
 * analyzer-event and runtime-context all go through SystemMessage, which
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

export function FeatureMessageLine({ message }: { message: AgentMessage }) {
  const [open, setOpen] = useState(false);

  if (message.content.type !== "text") return null;
  const metadata = featureMessageMetadata(message.content);
  const featureLabel = metadata?.featureName || metadata?.featureId || "Worker";
  const time = formatClockTime(message.createdAt);
  const absoluteTime = formatDateTimeTitle(message.createdAt);

  const text = message.content.text.trim();
  const summary = text.split("\n", 1)[0]?.trim() ?? "";
  // A reply already short enough to read in place has nothing behind it, and
  // an affordance onto an empty room is worse than no affordance.
  const hasMore = text.includes("\n") || text.length > INLINE_MAX_CHARS;

  const header = (
    <div className="flex items-center gap-2 text-2xs text-muted-foreground">
      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="font-mono uppercase">feature</span>
      <span className="min-w-0 truncate">{featureLabel}</span>
      {time ? (
        <time
          className="ml-auto shrink-0 tabular-nums"
          dateTime={message.createdAt}
          title={absoluteTime}
        >
          {time}
        </time>
      ) : null}
    </div>
  );

  if (!hasMore) {
    return (
      <div className="my-1 flex flex-col gap-1 border-l border-border/70 pl-2">
        {header}
        <div className="text-sm text-foreground">{text}</div>
      </div>
    );
  }

  return (
    <>
      <div className="my-1 flex flex-col gap-0.5 border-l border-border/70 pl-2">
        {header}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-xs py-0.5 text-left text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="min-w-0 flex-1 truncate text-foreground/90">{summary}</span>
          <span className="shrink-0 text-2xs font-medium text-muted-foreground">View reply</span>
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border-soft px-5 py-4">
            <DialogTitle className="text-base">{featureLabel}</DialogTitle>
            <DialogDescription>
              Reply from the worker.
              {absoluteTime && <span className="ml-2 tabular-nums">{absoluteTime}</span>}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto scrollbar-thin px-5 py-4 text-sm">
            <LazyMarkdownView text={text} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
