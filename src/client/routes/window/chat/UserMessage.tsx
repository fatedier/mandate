import { memo } from "react";
import { Loader2, AlertCircle, RotateCw, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatClockTime, formatDateTimeTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import { VoiceMarkerHeader } from "./VoiceMarkerHeader";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import { imageAttachmentSrc } from "./attachments";

interface UserMessageProps {
  text: string;
  attachments?: AgentMessageAttachment[];
  status: "sending" | "queued" | "sent" | "failed" | "persisted";
  error?: string;
  createdAt?: string;
  onRetry?: () => void;
  /** When true, prefix the bubble with a small mic icon to mark
   *  this message came from voice (not text typing). */
  voiceMarker?: boolean;
  /** When true, treat as in-progress / ephemeral (greyed out, pulsing). */
  ephemeral?: boolean;
}

function UserMessageImpl({ text, attachments = [], status, error, createdAt, onRetry, voiceMarker, ephemeral }: UserMessageProps) {
  const isFailed = status === "failed";
  const isSending = status === "sending";
  const isQueued = status === "queued";
  const messageTime = formatClockTime(createdAt);
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[78%] rounded-[16px_16px_4px_16px] bg-user-bubble px-3.5 py-2.5 text-foreground",
          isSending && "border border-border",
          isQueued && "border border-dashed border-border",
          ephemeral && "opacity-70",
          isFailed && "border border-red"
        )}
      >
        {voiceMarker && (
          <div className="mb-0.5">
            <VoiceMarkerHeader ephemeral={ephemeral} />
          </div>
        )}
        {attachments.length > 0 && (
          <div className="mb-2 grid max-w-64 grid-cols-2 gap-1.5">
            {attachments.map((attachment) => (
              <a
                key={attachment.id}
                href={imageAttachmentSrc(attachment)}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-md border border-border-soft bg-background/60"
                title={attachment.name || "Attached image"}
              >
                <img
                  src={imageAttachmentSrc(attachment)}
                  alt={attachment.name || "Attached image"}
                  className="h-24 w-full object-cover"
                />
              </a>
            ))}
          </div>
        )}
        {text && <div className="text-sm leading-[1.6] whitespace-pre-wrap break-words">{text}</div>}
        {messageTime && (
          <time
            className="mt-1 block text-right text-2xs tabular-nums text-faint"
            dateTime={createdAt}
            title={formatDateTimeTitle(createdAt)}
          >
            {messageTime}
          </time>
        )}
        {isSending && (
          <div className="flex items-center gap-1 mt-1 text-2xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> sending
          </div>
        )}
        {isQueued && (
          <div className="flex items-center gap-1 mt-1 text-2xs text-muted-foreground">
            <Clock3 className="h-3 w-3" /> queued
          </div>
        )}
        {isFailed && (
          <div className="flex items-center gap-2 mt-1 text-2xs text-red">
            <AlertCircle className="h-3 w-3" />
            <span className="truncate">{error ?? "send failed"}</span>
            {onRetry && (
              <Button variant="ghost" size="xs" className="text-red" onClick={onRetry}>
                <RotateCw /> Retry
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


// Memoised: the transcript re-renders on every streaming delta, and an
// unmemoised row means all of them re-render for each token.
export const UserMessage = memo(UserMessageImpl);
