import { cn } from "@/lib/utils";
import type { WorkItemDto } from "@shared/api/work-items";

const DOT: Record<WorkItemDto["phase"], string> = {
  design: "bg-phase-design",
  working: "bg-phase-working",
  verifying: "bg-phase-verifying",
  done: "bg-phase-done"
};

const TEXT: Record<WorkItemDto["phase"], string> = {
  design: "text-phase-design",
  working: "text-phase-working",
  verifying: "text-phase-verifying",
  done: "text-phase-done"
};

/** Declared work-item phase: colored dot + mono label. Renders state, not
 *  progress (phases can cycle and skip — never draw this as a bar).
 *  `active` adds the breathing pulse; use only when work is really running. */
export function PhaseDot({ phase, active, detail }: {
  phase: WorkItemDto["phase"];
  active?: boolean;
  detail?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[phase], active && "animate-live")} />
      <span className={cn("shrink-0", TEXT[phase])}>{phase}</span>
      {detail ? (
        <span className="min-w-0 truncate text-muted-foreground" title={detail}>
          · {detail}
        </span>
      ) : null}
    </span>
  );
}
