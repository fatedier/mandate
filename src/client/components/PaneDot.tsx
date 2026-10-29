import { cn } from "@/lib/utils";
import type { PaneDisplayStatus } from "@/routes/projects/feature-card-data";

const TONE: Record<NonNullable<PaneDisplayStatus>, string> = {
  running: "bg-live animate-live",
  idle: "bg-faint"
};

/** Pane aggregate status dot (tmux-derived, not analyzer interpretation). */
export function PaneDot({ status }: { status: PaneDisplayStatus }) {
  if (!status) return null;
  return <span aria-label={`pane ${status}`} className={cn("h-2 w-2 shrink-0 rounded-full", TONE[status])} />;
}
