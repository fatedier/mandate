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

/** Declared work-item phase: colored dot + mono phase word; detail is prose.
 *  Renders state, not progress (phases can cycle and skip — never draw this
 *  as a bar). `active` adds the breathing pulse; use only when work is really
 *  running. Mono is reserved for machine identifiers (§3.1), so it sits on
 *  the phase word only — never on the root, where the prose detail would
 *  inherit it. The root sets no text size: it inherits the host's, so the
 *  host decides which line of the ramp the phase line renders at. */
export function PhaseDot({ phase, active, detail }: {
  phase: WorkItemDto["phase"];
  active?: boolean;
  detail?: string;
}) {
  return (
    // `overflow-hidden` on the line: the dot and the word are `shrink-0`, the
    // detail is what gives way, and a line too short for even those clips at
    // its edge rather than spilling out of the row.
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[phase], active && "animate-live")} />
      <span className={cn("shrink-0 font-mono", TEXT[phase])}>{phase}</span>
      {detail ? (
        <span data-slot="phase-detail" className="min-w-0 truncate text-muted-foreground" title={detail}>
          · {detail}
        </span>
      ) : null}
    </span>
  );
}
