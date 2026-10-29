import { DECISION_THRESHOLD, readChatChoice } from "../answer.js";

/** What manager request check concludes of a thread's latest reply for one request. */
export type ManagerRequestCheckOutcome = "done" | "cannot" | "working";

/** Manager request check's answer from a chat model. */
export function readChatAnswer(text: string): ManagerRequestCheckOutcome | null {
  return readChatChoice(text, ["done", "cannot", "working"] as const);
}

/** A decision model's answer: done or cannot, whichever is likelier, once the
 *  two together reach the threshold; else working. */
export function requestOutcomeFromDecision(probabilities: Record<string, number>): ManagerRequestCheckOutcome {
  const done = probabilities.done ?? 0;
  const cannot = probabilities.cannot ?? 0;
  if (done + cannot < DECISION_THRESHOLD) return "working";
  return cannot > done ? "cannot" : "done";
}
