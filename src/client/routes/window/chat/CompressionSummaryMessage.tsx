import { useState } from "react";
import { FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { AgentMessage } from "@/store/agent-chat";
import { formatClockTime, formatDateTimeTitle } from "@/lib/format";

interface CompressionSummaryMessageProps {
  message: AgentMessage;
}

export function CompressionSummaryMessage({ message }: CompressionSummaryMessageProps) {
  const [open, setOpen] = useState(false);

  if (message.content.type !== "summary") return null;

  const count = message.content.replacedCount;
  const summary = message.content.summary.trim();
  const time = formatClockTime(message.createdAt);
  const absoluteTime = formatDateTimeTitle(message.createdAt);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-1 w-full rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-left text-sm transition-colors hover:border-border hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <span className="flex items-start gap-2">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-foreground">Conversation history compacted</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Compacted {count} earlier messages for future replies.
              {time && (
                <time
                  className="ml-2 tabular-nums"
                  dateTime={message.createdAt}
                  title={absoluteTime}
                >
                  {time}
                </time>
              )}
            </span>
          </span>
          <span className="mt-0.5 shrink-0 text-xs font-medium text-primary">View summary</span>
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border-soft px-5 py-4">
            <DialogTitle className="text-base">Conversation history compacted</DialogTitle>
            <DialogDescription>
              Compacted {count} earlier messages for future replies.
              {absoluteTime && (
                <time className="ml-2 tabular-nums" dateTime={message.createdAt}>
                  {absoluteTime}
                </time>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto scrollbar-thin px-5 py-4">
            <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
              {summary || "No summary text was produced."}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
