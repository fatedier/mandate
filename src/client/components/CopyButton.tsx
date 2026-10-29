import { useState, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** A mark's small fade as it takes the other's place. */
const SWAP = "animate-in fade-in-0 zoom-in-75 duration-150";

interface CopyButtonProps {
  text: string;
  /** Accessible name and tooltip; defaults to "Copy". */
  label?: string;
  className?: string;
}

/**
 * Quiet copy affordance for blocks of machine text.
 *
 * Rests at chrome contrast rather than revealing on hover: in a dense run of
 * tool calls a hover-only control is effectively undiscoverable, and copying is
 * the escape hatch when a block is too wide or too long to read in place.
 *
 * Swaps to a check for 1.5s on success — the confirmation has to live on the
 * control itself, since a toast for something this small would be louder than
 * the action.
 */
export function CopyButton({ text, label = "Copy", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  // Once it has copied, each mark comes in with a small fade: the check, and
  // the copy mark coming back. At rest, as the page opens, nothing moves.
  const [swapped, setSwapped] = useState(false);

  const onClick = async (e: MouseEvent) => {
    // These sit inside expand/collapse headers; a copy must not toggle them.
    e.preventDefault();
    e.stopPropagation();
    if (await copyTextToClipboard(text)) {
      setCopied(true);
      setSwapped(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "hit relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
        "text-chrome transition-colors hover:bg-foreground/10 hover:text-foreground",
        className
      )}
    >
      {copied
        ? <Check key="copied" className={cn("h-3.5 w-3.5 text-phase-done", swapped && SWAP)} aria-hidden />
        : <Copy key="copy" className={cn("h-3.5 w-3.5", swapped && SWAP)} aria-hidden />}
    </button>
  );
}
