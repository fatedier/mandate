import { Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePinToggle } from "./use-pin-toggle";

/** A row's pin in All: shown on hover (always on a touch screen), and kept
 *  shown while the pane is pinned. */
export function PinButton({ paneId, pid }: { paneId: string; pid: number }) {
  const { pinned, onToggle } = usePinToggle(paneId, pid);
  const label = pinned ? "Unpin" : "Pin";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pinned}
      onClick={onToggle}
      className={cn(
        "hit relative flex size-6 shrink-0 items-center justify-center rounded-sm text-faint transition-opacity hover:bg-background/60 hover:text-foreground pointer-coarse:size-11",
        pinned ? "text-status-review" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      )}
    >
      <Pin aria-hidden className={cn("size-3.5", pinned && "fill-current")} />
    </button>
  );
}
