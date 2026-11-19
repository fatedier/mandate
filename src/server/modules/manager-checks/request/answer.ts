import { DECISION_THRESHOLD } from "../answer.js";

/** What manager request check concludes of a thread's latest reply for one request. */
export type ManagerRequestCheckOutcome = "done" | "cannot" | "working";

/** A decision model's answer: done or cannot, whichever is likelier, once the
 *  two together reach the threshold; else working. */
export function requestOutcomeFromDecision(probabilities: Record<string, number>): ManagerRequestCheckOutcome {
  const done = probabilities.done ?? 0;
  const cannot = probabilities.cannot ?? 0;
  if (done + cannot < DECISION_THRESHOLD) return "working";
  return cannot > done ? "cannot" : "done";
}
