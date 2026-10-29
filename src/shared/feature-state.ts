import type { FeaturePlanDto } from "./api/plans.js";
import { planRounds } from "./plan-rounds.js";

/** A feature's one state, derived from its plan and how its last wake
 *  ended. `asking`: its plan holds a question and the worker rests, waiting
 *  for the answer. Whether it runs is separate, and matters only to
 *  `asking`. */
export type FeatureState = "failed" | "stopped" | "asking" | "planning" | "in_progress" | "blocked" | "paused" | "done";

/** A worker's state when it waits on someone, each with one name wherever it
 *  is shown: a question put to the user (yellow), a wake that failed (red),
 *  one stopped short (red). */
export const WAITING_LABEL = {
  input: "Needs you",
  failed: "Failed",
  stopped: "Stopped"
} as const;

/** A worker that asked and rests. Its question is its manager's first, so
 *  this is not among what waits on the user. */
export const ASKING_LABEL = "Waiting for an answer";

/** Why a worker's last wake ended without finishing. */
export type FailureKind = "error" | "stopped";

export const FEATURE_STATE_LABEL: Record<FeatureState, string> = {
  failed: WAITING_LABEL.failed,
  stopped: WAITING_LABEL.stopped,
  asking: ASKING_LABEL,
  planning: "Planning",
  in_progress: "In progress",
  blocked: "Blocked",
  paused: "Paused",
  done: "Done"
};

type PlanLike = (Pick<FeaturePlanDto, "steps"> & Partial<Pick<FeaturePlanDto, "openQuestions" | "earlierWork">>) | null | undefined;

/** A worker asks by writing a question into its plan: nothing else records it. */
export function isAsking(plan: Partial<Pick<FeaturePlanDto, "openQuestions">> | null | undefined): boolean {
  return (plan?.openQuestions?.length ?? 0) > 0;
}

/** A step of the plan is in progress: the worker says it is still at work. */
export function hasStepInProgress(plan: { steps?: ReadonlyArray<{ status: string }> } | null | undefined): boolean {
  return plan?.steps?.some((step) => step.status === "in_progress") ?? false;
}

/** `running`: the worker's turn is under way. A question it wrote does not
 *  change its state until it rests: it may have more to do first. A caller
 *  that cannot know reads the worker at rest. */
export function featureStateFor(
  plan: PlanLike,
  failedAt: string | null = null,
  failedKind: FailureKind | null = null,
  running = false
): FeatureState {
  // A wake that ended in an error, or was stopped, is what happened until a
  // later wake of the same worker finishes: it outranks a question.
  if (failedAt) return failedKind === "stopped" ? "stopped" : "failed";
  if (!running && isAsking(plan)) return "asking";
  const steps = plan?.steps ?? [];
  // A plan sent to the page right after a goal change can hold no step of
  // its own and only earlier work: that work is done, not unwritten.
  if (steps.length === 0 && !plan?.earlierWork) return "planning";
  if (steps.some((s) => s.status === "in_progress")) return "in_progress";
  if (steps.some((s) => s.status === "blocked")) return "blocked";
  if (steps.some((s) => s.status === "pending")) return "paused";
  // Every step done and a question asked in the turn still running: it is at
  // work on the answer, not done (once it rests it is asking, above).
  return running && isAsking(plan) ? "in_progress" : "done";
}

/** What the worker is waiting on you for, if anything: Home's "Waiting on
 *  you", the thread dot, the panel's first groups. A question is not among
 *  these: it is the manager's first (isAsking). */
export function waitingOnYou(
  failedAt: string | null | undefined,
  failedKind: FailureKind | null = null
): "failed" | "stopped" | null {
  return failedAt ? (failedKind === "stopped" ? "stopped" : "failed") : null;
}

/** How far the current work has come: the steps of the current goal and any
 *  still open (planRounds), not the earlier goals' finished ones. */
export function planProgress(plan: (PlanLike & Partial<Pick<FeaturePlanDto, "goalHistory">>) | null | undefined): { done: number; total: number } {
  const steps = plan ? planRounds(plan).current : [];
  return { done: steps.filter((s) => s.status === "done").length, total: steps.length };
}

/** The first tmux pane id (`%133`) a note names, or null. A `%` glued to a
 *  word or number ("100%5") is not a pane; after any other character
 *  ("pane=%133", "[%133]") it is. */
export function firstPaneId(text: string | null | undefined): string | null {
  const match = /(?<![\w%])(%\d+)\b/.exec(text ?? "");
  return match ? match[1]! : null;
}

interface FeatureStateLine {
  state: FeatureState;
  /** The word before the text; null when the text stands alone. */
  lead: "Now:" | "Blocked:" | "Next:" | "Open question:" | "Failed:" | "Stopped:" | null;
  text: string;
  /** For In progress: the pane the step's note names, if any. */
  pane: string | null;
}

/** The feature in one line, as Home reads it. */
export function featureStateLine(
  plan: Pick<FeaturePlanDto, "steps" | "conclusion" | "openQuestions"> | null | undefined,
  failure: { at: string | null; message: string | null; kind?: FailureKind | null } | null = null,
  running = false
): FeatureStateLine {
  const state = featureStateFor(plan, failure?.at ?? null, failure?.kind ?? null, running);
  const steps = plan?.steps ?? [];
  const conclusion = plan?.conclusion?.trim() || "";
  const first = (status: string) => steps.find((s) => s.status === status);
  switch (state) {
    case "asking":
      return { state, lead: "Open question:", text: plan?.openQuestions?.[0]?.trim() ?? "", pane: null };
    case "failed":
      return { state, lead: "Failed:", text: failure?.message?.trim() || "The wake ended in an error.", pane: null };
    case "stopped":
      return { state, lead: "Stopped:", text: failure?.message?.trim() || "Stopped.", pane: null };
    case "planning":
      // A plan with a conclusion and no steps yet reads as its conclusion.
      return { state, lead: null, text: conclusion || "No plan yet", pane: null };
    case "in_progress": {
      const step = first("in_progress");
      return { state, lead: "Now:", text: step?.title ?? "", pane: firstPaneId(step?.note) };
    }
    case "blocked":
      return { state, lead: "Blocked:", text: first("blocked")?.title ?? "", pane: null };
    case "paused":
      return { state, lead: "Next:", text: first("pending")?.title ?? "", pane: null };
    case "done":
      return { state, lead: null, text: conclusion, pane: null };
  }
}
