import { memo } from "react";
import { MarkdownView } from "@/components/MarkdownView";

interface StreamingAssistantMessageProps {
  text: string;
  /** Its key as a row of the transcript, when it is one (arriving-rows). */
  rowKey?: string;
}

export const StreamingAssistantMessage = memo(function StreamingAssistantMessage({ text, rowKey }: StreamingAssistantMessageProps) {
  return (
    <div data-slot="streaming-reply" data-row-key={rowKey} className="flex flex-col gap-1">
      <div className="relative">
        <MarkdownView text={text || " "} />
        <span className="inline-block w-1 h-3 bg-foreground/70 ml-0.5 align-middle animate-pulse" aria-hidden="true" />
      </div>
    </div>
  );
});
