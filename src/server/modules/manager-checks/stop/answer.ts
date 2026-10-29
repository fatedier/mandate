import type { StopVerdict } from "../../../../shared/thread-dot.js";
import { DECISION_THRESHOLD } from "../answer.js";

/** What the manager stop check can find, in the prompt's order. */
export const STOP_OPTIONS = ["decision", "result", "nothing"] as const satisfies readonly StopVerdict[];

/** A decision model's answer: decision or result, whichever is likelier,
 *  once the two together reach the threshold; else nothing. */
export function stopOutcomeFromDecision(probabilities: Record<string, number>): StopVerdict {
  const decision = probabilities.decision ?? 0;
  const result = probabilities.result ?? 0;
  if (decision + result < DECISION_THRESHOLD) return "nothing";
  return result > decision ? "result" : "decision";
}
