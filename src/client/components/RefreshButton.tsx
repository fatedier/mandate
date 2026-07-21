import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface RefreshButtonProps {
  onRefresh: () => void;
  /** Spinning + disabled while a refresh is in flight. */
  refreshing?: boolean;
  /** Disabled for a reason other than an in-flight refresh (initial load). */
  disabled?: boolean;
  /** What gets refreshed, lowercase, for the accessible name: "settings"
   *  becomes "Refresh settings". Omit when the page has exactly one refresh
   *  and "Refresh" is unambiguous. */
  what?: string;
  /** Both are icon-only; the difference is weight. `page` sits alone in a page
   *  header and takes an outline so it reads as a control rather than a stray
   *  glyph. `local` sits among content or beside other icons and stays ghost.
   *
   *  Neither carries a label. The first draft gave `page` one, on the reading
   *  that a page header's refresh is the thing you came to do — but no page
   *  here works that way: they all load on mount and most take SSE, so refresh
   *  is a fallback everywhere. The justification did not survive being written
   *  down. */
  scope?: "page" | "local";
  /** Icon box size. Defaults to `icon-sm` (32px); pass `icon` (36px) when the
   *  button sits beside neighbours of that size, as in the feature header. */
  size?: "icon" | "icon-sm";
  className?: string;
}

/**
 * The one refresh control.
 *
 * Before this existed there were ten, in four shapes: `outline`/`sm` with bare
 * text and no icon (Sessions ×3), `outline`/`sm` with an icon and a responsive
 * label (Memory, Activity, both Canvas pages), `ghost`/`icon-sm` (Settings),
 * `outline`/`icon-sm` with an `sr-only` label (SetupChecklist), `ghost`/`icon`
 * (the feature header), and a bare `<button>` that never reached the design
 * system at all (ChangesTab). Four of them had already converged on the same
 * shape without anyone writing it down, which is what `page` is.
 *
 * Keep new refreshes going through here. Ten call sites drifting apart is what
 * happens when the shape lives at the call site.
 */
export function RefreshButton({
  onRefresh,
  refreshing = false,
  disabled = false,
  what,
  scope = "page",
  size = "icon-sm",
  className
}: RefreshButtonProps) {
  const label = what ? `Refresh ${what}` : "Refresh";
  const busyLabel = what ? `Refreshing ${what}` : "Refreshing";

  if (scope === "local") {
    return (
      <Button
        variant="ghost"
        size={size}
        onClick={onRefresh}
        disabled={refreshing || disabled}
        aria-label={refreshing ? busyLabel : label}
        title={label}
        className={cn("text-chrome", className)}
      >
        <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size={size}
      onClick={onRefresh}
      disabled={refreshing || disabled}
      aria-label={refreshing ? busyLabel : label}
      title={label}
      className={className}
    >
      <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
    </Button>
  );
}
