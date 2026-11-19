import { ArrowRight } from "lucide-react";
import type { MemoryDreamRunDto } from "@shared/api-contracts";
import { cn } from "@/lib/utils";

export function StatusPill({ status }: { status: string }) {
  const tone = status === "succeeded" || status === "applied"
    ? "border-phase-done/30 bg-phase-done/10 text-phase-done"
    : status === "running"
      ? "border-phase-working/30 bg-phase-working/10 text-phase-working"
      : status === "rejected"
        ? "border-amber/30 bg-amber/10 text-amber"
        : "border-destructive/30 bg-destructive/10 text-destructive";
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center rounded-xs border px-1.5 text-2xs font-medium", tone)}>
      {status}
    </span>
  );
}

/**
 * What an action did to its memory. Colour follows the signal grammar — it
 * declares a kind, not an urgency — so the eye can sort a run's actions
 * without reading them: amber leaves, blue rewrites, violet joins, cyan
 * re-files, and a kept memory stays furniture.
 */
const EFFECT_TONE: Record<string, string> = {
  update: "border-phase-working/35 bg-phase-working/10 text-phase-working",
  merge: "border-phase-design/35 bg-phase-design/10 text-phase-design",
  archive: "border-amber/35 bg-amber/10 text-amber",
  move: "border-phase-verifying/35 bg-phase-verifying/10 text-phase-verifying",
  split: "border-live/35 bg-live/10 text-live",
  brief: "border-live/35 bg-live/10 text-live",
  other: "border-border-soft text-muted-foreground"
};

const EFFECT_LABEL: Record<string, string> = {
  update: "Updated",
  merge: "Merged",
  archive: "Archived",
  move: "Moved",
  split: "Split",
  brief: "Brief"
};

export function EffectChip({ effect }: { effect: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-xs border px-1.5 text-2xs font-medium",
        EFFECT_TONE[effect] ?? EFFECT_TONE.other
      )}
    >
      {EFFECT_LABEL[effect] ?? effect}
    </span>
  );
}

export function DreamPartitionPill({ run, className }: { run: MemoryDreamRunDto; className?: string }) {
  const label = run.phase === "project"
    ? run.projectName || run.projectId || "project"
    : "You";
  return (
    // Not label-micro: that utility uppercases, and this chip holds a project's
    // own name. Shouted in capitals, a project's name reads like a status
    // code rather than the project it is.
    <span
      className={cn("inline-flex h-5 max-w-40 shrink-0 items-center truncate rounded-xs border border-border-soft px-1.5 text-2xs text-muted-foreground", className)}
      title={run.phase === "project" ? run.projectId ?? label : "User and global memory"}
    >
      {label}
    </span>
  );
}

/** Inline pill: shows total memory count change across the run, e.g.
 *  "42 → 39 (−3)". Hidden while the run has no after count, and when
 *  nothing moved: a chip saying so beside a summary that already says
 *  "20 kept". */
export function MemoryCountDelta({ run }: { run: MemoryDreamRunDto }) {
  const before = run.availableCountBefore;
  const after = run.availableCountAfter;
  if (after == null) return null;
  const delta = after - before;
  if (delta === 0) return null;
  const tone = delta < 0 ? "text-phase-done" : "text-amber";
  const sign = delta > 0 ? "+" : "−";
  const abs = Math.abs(delta);
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 rounded-xs border border-border-soft px-1.5 py-0.5 text-2xs font-mono tabular-nums text-muted-foreground"
      title={`Available memories: ${before} → ${after}`}
    >
      <span className="inline-flex items-center gap-0.5">
        {before}
        <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
        {after}
      </span>
      <span className={tone}>({sign}{abs})</span>
    </span>
  );
}
