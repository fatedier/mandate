import type { ThreadDot } from "./thread-dot.js";

/** Every word Mandate shows or says for a status, in one place: the sidebar's
 *  mark, Home's rows, the badges, Your agent's page and context, and voice
 *  all read these. */

/** What waits on the user: a thread whose own turn failed or stopped, a
 *  question for them, or a stopped thread whose latest reply leaves them a
 *  decision or a result to read. */
export type WaitingKind = "failed" | "stopped" | "input" | "decision" | "result";

export const WAITING_WORD: Record<WaitingKind, string> = {
  failed: "Failed",
  stopped: "Stopped",
  input: "Needs you",
  decision: "Decision needed",
  result: "Result to read"
};

/** One order everywhere: what broke, then questions, then decisions, then
 *  results. */
export const WAITING_ORDER: Record<WaitingKind, number> = { failed: 0, stopped: 0, input: 1, decision: 2, result: 3 };

/** A thread's mark, read out ("state: …"). */
export const DOT_ARIA: Record<ThreadDot, string> = {
  failed: "failed or stopped",
  needs_you: "needs you",
  decision: "decision needed",
  result: "result to read",
  working: "working",
  watching: "watching",
  idle: "idle"
};

/** A thread's state as Your agent reads it (its runtime context and
 *  list_threads): the sidebar's, with a stop told apart from a failure. */
export const CONTEXT_WORD: Record<ThreadDot | "stopped", string> = {
  failed: "failed",
  stopped: "stopped",
  needs_you: "needs you",
  decision: "decision needed",
  result: "result to read",
  working: "working",
  watching: "watching",
  idle: "idle"
};

/** The sidebar's order: what wants the user first, then what is worth their
 *  look, then the rest by activity. */
export const SIDEBAR_RANK: Record<ThreadDot, number> = {
  failed: 0, needs_you: 0, decision: 1, result: 1, working: 2, watching: 2, idle: 2
};
