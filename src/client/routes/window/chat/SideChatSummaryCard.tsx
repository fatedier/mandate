import { memo } from "react";
import { cn } from "@/lib/utils";
import { MarkdownView } from "@/components/MarkdownView";
import type { SideChatPart } from "@shared/agent-message-types";
import { sideChatSummaryFolds } from "./transcript-rows";

/** A side chat the user sent to the personal agent, on their message: the summary
 *  written around their note (folded when long) and the file that keeps the
 *  whole side chat. What the model read of it is not drawn. */
export const SideChatSummaryCard = memo(function SideChatSummaryCard({ part, open, onOpenChange }: {
  part: SideChatPart;
  /** Opened, as the list holds it: an opened one holds the reader's place. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const foldable = sideChatSummaryFolds(part.summary);
  const folded = foldable && !open;
  return (
    <div
      data-slot="side-chat-summary"
      data-folded={folded ? "true" : "false"}
      className="w-full max-w-[85%] self-end rounded-lg border border-border bg-panel px-3 py-2"
    >
      <div className="text-xs font-semibold text-chrome">Side chat summary</div>
      <div className={cn("relative mt-1", folded && "max-h-[6.4em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>
        <MarkdownView text={part.summary} dense />
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs">
        {foldable && (
          <button type="button" onClick={() => onOpenChange(!open)} className="text-muted-foreground transition-colors hover:text-foreground">
            {open ? "Show less" : "Show all"}
          </button>
        )}
        <MarkdownView text={`[Full side chat](<${part.file}>)`} small />
      </div>
    </div>
  );
});
