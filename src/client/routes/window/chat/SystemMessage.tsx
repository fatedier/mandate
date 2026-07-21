import { memo } from "react";
import { AlertTriangle } from "lucide-react";
import type { AgentMessage } from "@/store/agent-chat";
import { formatClockTime, formatDateTimeTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ChatProvenanceLine } from "./ChatProvenanceLine";
import { provenanceForSystemMessage } from "./chatProvenance";

interface SystemMessageProps {
  message: AgentMessage;
}

function SystemMessageImpl({ message }: SystemMessageProps) {
  const provenance = provenanceForSystemMessage(message);
  if (provenance) {
    return <ChatProvenanceLine provenance={provenance} />;
  }

  const source = message.source;
  let color: string;
  let label: string;

  color = "text-amber bg-amber/5";
  label = source;

  let text = "(system)";
  if (message.content.type === "text") text = message.content.text;
  else if (message.content.type === "summary")
    text = `Compressed ${message.content.replacedCount} earlier messages`;
  const time = formatClockTime(message.createdAt);

  return (
    <div className={cn("flex items-center gap-2 px-2 py-1 my-1 rounded-sm text-2xs", color)}>
      <AlertTriangle className="h-3.5 w-3.5" />
      <span className="font-mono label-micro">{label}</span>
      <span className="truncate">{text}</span>
      {time && (
        <time
          className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground"
          dateTime={message.createdAt}
          title={formatDateTimeTitle(message.createdAt)}
        >
          {time}
        </time>
      )}
    </div>
  );
}

// Memoised: the transcript re-renders on every streaming delta, and an
// unmemoised row means all of them re-render for each token.
export const SystemMessage = memo(SystemMessageImpl);
