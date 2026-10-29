import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { AgentMessage } from "@/store/agent-chat";
import { formatDateTime, formatDateTimeTitle } from "@/lib/format";
import { formatTokenCount } from "@/routes/activity/activity-model";
import { MarkdownView } from "@/components/MarkdownView";
import { ContextBoundary } from "./ContextBoundary";

interface CompressionSummaryMessageProps {
  message: AgentMessage;
}

export function CompressionSummaryMessage({ message }: CompressionSummaryMessageProps) {
  const [open, setOpen] = useState(false);

  if (message.content.type !== "summary") return null;

  // What this compaction compacted itself; never `replacedCount`, the
  // conversation's running total, which takes in every earlier summary's.
  const count = message.content.compactedCount;
  const counted = count === undefined
    ? "earlier messages"
    : `${count.toLocaleString("en-US")} earlier ${count === 1 ? "message" : "messages"}`;
  const summary = message.content.summary.trim();
  const absoluteTime = formatDateTimeTitle(message.createdAt);
  const before = message.content.tokensBefore;

  return (
    <>
      <ContextBoundary>
        {/* The size the context was compacted at, where it was measured.
            Not what was saved: that needs the size afterwards, which could
            only be estimated and read high. */}
        {count === undefined && before ? "Compacted" : `Compacted ${counted}`}
        {before ? ` at ${formatTokenCount(before)} tokens` : null}
        {/* An idle compaction says why it ran. */}
        {message.content.trigger === "idle" && message.content.idleMinutes !== undefined ? ` after ${message.content.idleMinutes} min idle` : null}
        {" · "}
        <button
          type="button"
          onClick={() => setOpen(true)}
          // A 44px line on a touch screen.
          className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground pointer-coarse:min-h-11"
        >
          View summary
        </button>
      </ContextBoundary>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border-soft px-5 py-4">
            <DialogTitle className="text-base">Conversation history compacted</DialogTitle>
            <DialogDescription>
              Compacted {counted} for future replies.
              {absoluteTime && (
                <time className="ml-2 tabular-nums" dateTime={message.createdAt} title={absoluteTime}>
                  {formatDateTime(message.createdAt)}
                </time>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto px-5 py-4">
            {/* The model writes the summary in Markdown, as its replies. */}
            {summary
              ? <MarkdownView text={summary} dense />
              : <p className="text-sm text-foreground">No summary text was produced.</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
