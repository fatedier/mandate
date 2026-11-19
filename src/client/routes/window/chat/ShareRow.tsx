import { memo, type KeyboardEvent, type MouseEvent } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownView } from "@/components/MarkdownView";
import { UserMessage } from "./UserMessage";

/** A shared row's words as the chat draws them: the user's bubble, or a
 *  reply's Markdown. The same while picking and in the image. */
export function SharedWords({ side, text }: { side: "user" | "agent"; text: string }) {
  return side === "user"
    ? <UserMessage text={text} status="persisted" />
    : <div className="flex flex-col gap-1.5 text-sm leading-[1.6]"><MarkdownView text={text} /></div>;
}

/** A row while messages are picked to share: the user's words as their
 *  bubble, a reply's text as the chat draws it, and nothing else of it. The
 *  whole row is one checkbox: a click or Space picks it or not, Shift-click
 *  picks the run from the row clicked last; nothing inside answers a click,
 *  and its text is not selected. Picked: a soft tint and a tick in its
 *  corner (the bubble's left, a reply's right); not picked: nothing. */
export const ShareRow = memo(function ShareRow({ rowKey, side, text, selected, joinedAbove = false, joinedBelow = false, onToggle }: {
  rowKey: string;
  side: "user" | "agent";
  text: string;
  selected: boolean;
  /** Picked, as the row drawn above / below it is: one run, one wash. */
  joinedAbove?: boolean;
  joinedBelow?: boolean;
  onToggle: (key: string, range: boolean) => void;
}) {
  const onClick = (event: MouseEvent) => onToggle(rowKey, event.shiftKey);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    onToggle(rowKey, event.shiftKey);
  };
  return (
    <div
      data-slot="share-row"
      data-row-key={rowKey}
      data-side={side}
      role="checkbox"
      aria-checked={selected}
      data-joined-above={joinedAbove || undefined}
      data-joined-below={joinedBelow || undefined}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        // The wash reaches 8px into the 16px gap on each side, so two rows' meet;
        // where a run goes on, 1px further, under the next, so no seam shows.
        "relative -mx-2.5 -mt-2 cursor-pointer select-none px-2.5 pt-2 outline-none transition-colors duration-150",
        joinedBelow ? "-mb-[9px] pb-[9px]" : "-mb-2 pb-2",
        joinedAbove ? (joinedBelow ? "" : "rounded-b-xl") : joinedBelow ? "rounded-t-xl" : "rounded-xl",
        "focus-visible:ring-2 focus-visible:ring-ring",
        side === "user" ? "pl-9" : "pr-9",
        // The tick is the second cue.
        selected ? "bg-pick" : "pointer-fine:hover:bg-pick/50"
      )}
    >
      <div className="pointer-events-none">
        <SharedWords side={side} text={text} />
      </div>
      {selected && (
        <span
          aria-hidden
          className={cn(
            "absolute top-2.5 flex size-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground",
            side === "user" ? "left-2.5" : "right-2.5"
          )}
        >
          <Check className="size-3" strokeWidth={3} />
        </span>
      )}
    </div>
  );
});
