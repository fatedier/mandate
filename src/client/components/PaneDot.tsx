import { cn } from "@/lib/utils";
import type { PaneDisplayStatus } from "@/routes/projects/worker-card-data";

const TONE: Record<NonNullable<PaneDisplayStatus>, string> = {
  running: "bg-live animate-live",
  idle: "bg-faint"
};

/** A worker's pane dot: running or idle, from its window's status. */
export function PaneDot({ status }: { status: PaneDisplayStatus }) {
  if (!status) return null;
  return <span aria-label={`pane ${status}`} className={cn("h-2 w-2 shrink-0 rounded-full", TONE[status])} />;
}
