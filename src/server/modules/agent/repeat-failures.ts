/**
 * The repeat stop: the same tool failing the same way, over and
 * over. Counts consecutive failures of one call per thread — tool, arguments
 * and error (digits and ids masked, nothing else) — across steps and wakes.
 * A successful call of anything but bookkeeping ends the streak, as does a
 * person's message (reset). A shell command that exits non-zero is not a tool
 * failure, so iterating on a failing test never counts. Held in memory: a
 * restart clears it, which can only miss a streak, never invent one.
 */
const REPEAT_NUDGE_AT = 3;
const REPEAT_STOP_AT = 5;

export const REPEAT_NUDGE_TEXT =
  "[Mandate] This exact call has failed 3 times in a row with the same error. Change your approach; " +
  "if you are waiting for something to become ready, schedule a wake instead of retrying now.";

/** What the model reads with the failure that stops its turn: why the turn
 *  ends there, and what to do when it is next woken (by a person, or, where a
 *  stop does not hold the conversation, by whatever happens next). */
export function repeatStopText(count: number): string {
  return `[Mandate] This exact call has now failed ${count} times in a row with the same error. A turn that keeps doing this is stopped. ` +
    "Do not make this call again: do what you were doing another way, or say what is in the way.";
}

/** Calls that only record intent or read notes: their success is not
 *  progress, so "fail → set an alarm → fail" still counts as a streak.
 *  Changing this set changes which loops are caught. */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  "schedule_wake", "update_plan", "memory_search", "memory_remember",
  "skill", "chat_history_search", "chat_history_read"
]);

export interface ToolOutcome {
  toolName: string;
  args: unknown;
  isError: boolean;
  error?: string;
}

export interface RepeatVerdict {
  /** This failure is the REPEAT_NUDGE_AT-th in a row: tell the model. */
  nudge: boolean;
  /** REPEAT_NUDGE_AT… reached REPEAT_STOP_AT: end the wake after this step. */
  stop: boolean;
  count: number;
}

export function maskError(error: string): string {
  return error
    .replace(/\b[a-z]+_[A-Za-z0-9_-]{8,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .trim();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

export function failureKey(toolName: string, args: unknown, error: string): string {
  return JSON.stringify([toolName, canonical(args ?? null), maskError(error)]);
}

const NONE: RepeatVerdict = { nudge: false, stop: false, count: 0 };

export class RepeatFailureTracker {
  private readonly streaks = new Map<string, { key: string; count: number }>();
  /** Keys already counted in the current step, per thread. */
  private readonly stepKeys = new Map<string, Set<string>>();

  beginStep(threadId: string): void {
    this.stepKeys.set(threadId, new Set());
  }

  record(threadId: string, outcome: ToolOutcome): RepeatVerdict {
    if (!outcome.isError) {
      if (!BOOKKEEPING_TOOLS.has(outcome.toolName)) this.streaks.delete(threadId);
      return NONE;
    }
    const key = failureKey(outcome.toolName, outcome.args, outcome.error ?? "");
    const seen = this.stepKeys.get(threadId) ?? new Set<string>();
    this.stepKeys.set(threadId, seen);
    const streak = this.streaks.get(threadId);
    if (seen.has(key)) {
      // Issued together with an identical call in this step: counted once.
      // Still the step's latest failure: if another call's failure (or a
      // success) came between, the streak is this call's again, from one.
      if (streak?.key === key) return { nudge: false, stop: false, count: streak.count };
      this.streaks.set(threadId, { key, count: 1 });
      return { nudge: false, stop: false, count: 1 };
    }
    seen.add(key);
    const count = streak?.key === key ? streak.count + 1 : 1;
    this.streaks.set(threadId, { key, count });
    return { nudge: count === REPEAT_NUDGE_AT, stop: count >= REPEAT_STOP_AT, count };
  }

  /** The thread's streak has reached the stop — still, after every outcome
   *  recorded so far (a later success in the same step clears it). */
  isStopped(threadId: string): boolean {
    return (this.streaks.get(threadId)?.count ?? 0) >= REPEAT_STOP_AT;
  }

  reset(threadId: string): void {
    this.streaks.delete(threadId);
    this.stepKeys.delete(threadId);
  }
}
