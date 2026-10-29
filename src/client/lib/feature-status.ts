import type { FeaturePlanDto } from "@shared/api/plans";
import { FEATURE_STATE_LABEL, featureStateFor, WAITING_LABEL, type FailureKind, type FeatureState } from "@shared/feature-state";

export type PillTone = "red" | "green" | "blue" | "cyan" | "violet" | "amber" | "neutral";

/** One pill: the feature's state, derived from its plan. A failure and a
 *  question the worker waits on (amber: it is its manager's first, not the
 *  user's) win over what the steps say. `running`: the worker's turn is under
 *  way, so a question it wrote has not stopped it yet. Pure — no React — so
 *  the header module exports only a component. */
export function featureStatePill(
  plan: FeaturePlanDto | null,
  /** When the worker's last wake failed or was stopped (WorkItemDto.failedAt), and which. */
  failedAt: string | null = null,
  failedKind: FailureKind | null = null,
  running = false
): { label: string; tone: PillTone; state: FeatureState } {
  const state = featureStateFor(plan, failedAt, failedKind, running);
  return { label: FEATURE_STATE_LABEL[state], tone: stateTone(state), state };
}

/** A worker state's colour: red for a failure, blue at work, amber when it
 *  waits, green when done. */
export function stateTone(state: FeatureState): PillTone {
  return state === "failed" || state === "stopped" ? "red"
    : state === "in_progress" ? "blue"
      : state === "blocked" || state === "asking" ? "amber"
        : state === "done" ? "green"
          : "neutral";
}

/** A state's dot, by its colour: Home's rows and a panel's worker tabs. */
export const PILL_DOT_CLASS: Record<PillTone, string> = {
  red: "bg-red",
  blue: "bg-phase-working",
  amber: "bg-amber",
  green: "bg-phase-done",
  cyan: "bg-faint",
  violet: "bg-faint",
  neutral: "bg-faint"
};

/** A worker's state in words: why it waits on you when it does, one name per
 *  way (WAITING_LABEL); otherwise what its plan says. */
/** A worker asleep on a monitor, as its chat's waiting line says it; or on
 *  its subagent's result, as its question is "Waiting for an answer". */
export const MONITOR_WAIT_LABEL = { pane: "Watching", command: "Monitoring", subagent: "Waiting for a subagent", "background-command": "Waiting for a command", alarm: "Waiting for a wake" } as const;

export function waitingStateLabel(w: { state: FeatureState; waiting: "failed" | "stopped" | null }): string {
  return w.waiting ? WAITING_LABEL[w.waiting] : FEATURE_STATE_LABEL[w.state];
}
