import { cn } from "@/lib/utils";

export type StatusRailTone = "input" | "review" | "neutral";

const TONE: Record<StatusRailTone, string> = {
  input: "bg-status-input shadow-[var(--shadow-glow-red)]",
  review: "bg-status-review shadow-[var(--shadow-glow-amber)]",
  neutral: "bg-border"
};

/** 3px colored left edge for feature cards — the at-a-glance needsUser
 *  signal. Parent must be `relative overflow-hidden`. */
export function StatusRail({ tone }: { tone: StatusRailTone }) {
  return <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", TONE[tone])} />;
}
