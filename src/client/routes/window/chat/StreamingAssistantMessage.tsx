import { memo } from "react";
import { LazyMarkdownView } from "@/components/LazyMarkdownView";

interface StreamingAssistantMessageProps {
  text: string;
}

export const StreamingAssistantMessage = memo(function StreamingAssistantMessage({ text }: StreamingAssistantMessageProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <LazyMarkdownView text={text || " "} />
        <span className="inline-block w-1 h-3 bg-foreground/70 ml-0.5 align-middle animate-pulse" aria-hidden="true" />
      </div>
    </div>
  );
});
