import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface HoverSwapProps {
  /** Shown at rest — typically metadata (a timestamp, a count). */
  rest: ReactNode;
  /** Shown while the host is hovered or focused — typically row actions. */
  hover: ReactNode;
  /** Extra classes for the wrapper (e.g. gap overrides). */
  className?: string;
}

/**
 * Cross-fades a row's resting metadata with its hover actions.
 *
 * Both children are stacked in a single CSS grid cell, so the cell is always as
 * wide as the wider of the two and the surrounding row never reflows when the
 * pointer arrives. The previous approach — `md:group-hover:hidden` on one
 * cluster and `hidden md:group-hover:flex` on the other — swapped two
 * different-width blocks via `display`, which made the whole row jump on hover
 * and cut straight from one to the other with no transition. That jump is the
 * single most legible piece of roughness in a card list.
 *
 * Requires an ancestor with the `group` class.
 *
 * Two behaviours worth keeping:
 * - Mobile keeps only `rest` (no hover exists there), matching the previous
 *   behaviour where the action cluster was `hidden` below `md`.
 * - `group-focus-within` reveals the actions for keyboard users. Under the old
 *   `display: none` they were not focusable at all on desktop, so the actions
 *   were keyboard-unreachable; opacity keeps them in the tab order, and this
 *   makes them visible once focus lands.
 */
export function HoverSwap({ rest, hover, className }: HoverSwapProps) {
  return (
    <div className={cn("relative grid shrink-0 grid-cols-1 grid-rows-1", className)}>
      <div
        className={cn(
          "col-start-1 row-start-1 flex items-center justify-end gap-2 transition-opacity",
          "md:group-hover:pointer-events-none md:group-hover:opacity-0",
          "md:group-focus-within:pointer-events-none md:group-focus-within:opacity-0"
        )}
      >
        {rest}
      </div>
      <div
        className={cn(
          "col-start-1 row-start-1 hidden items-center justify-end gap-1.5 transition-opacity",
          "md:flex md:pointer-events-none md:opacity-0",
          "md:group-hover:pointer-events-auto md:group-hover:opacity-100",
          "md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100"
        )}
      >
        {hover}
      </div>
    </div>
  );
}
