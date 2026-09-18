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
        className="my-0.5 flex h-6 w-full items-center gap-2 px-1 text-left text-2xs text-faint transition-colors hover:text-foreground"
      >
        <FileText className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0 label-micro">Context</span>
        <span className="min-w-0 truncate">compressed {count} earlier messages</span>
        <span className="shrink-0">View summary</span>
        {time && (
          <time className="ml-auto shrink-0 tabular-nums" dateTime={message.createdAt} title={absoluteTime}>
            {time}
          </time>
        )}
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
