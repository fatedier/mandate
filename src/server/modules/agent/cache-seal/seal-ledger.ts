/**
 * Each model's cache-seal state. Active, its steps write their messages for
 * five minutes and a quiet thread is sealed for an hour. A seal that fails
 * (its write was not an hour long, it cost more than a token of output, three
 * requests failed in a row, or the next step could not read it) pauses the
 * model: its steps go back to hour-long marks, as before sealing, and one
 * seal is let through as a try, 1 h after the failure, then 4 h, then 24 h,
 * then daily. A try resumes sealing once it passes both layers; one that is
 * excused or never judged stays open. The count of failures goes back to zero
 * after a day active without one. Kept in memory: a restart starts afresh.
 *
 * What a seal finds is told with the ticket it started with (`startSeal`):
 * a pass counts for that seal alone, and only a try of the current pause can
 * resume the model — not a seal started before the pause, nor another seal's
 * pass lent to it. A failure counts only in the state its seal started in:
 * the other seals out when a model paused, or a try of a pause it has left,
 * found the fault already counted.
 */

export type SealFailure = "short_write" | "output" | "errors" | "not_read" | "prefix_changed";

export interface SealPause {
  connection: string;
  model: string;
  failure: SealFailure;
  /** When a seal may go through again, as a try (ms since the epoch). */
  nextTryAt: number;
  /** The seal's output tokens, for an `output` failure. */
  outputTokens?: number;
}

/** One seal of a model, from its start to its judgements. */
export interface SealTicket {
  readonly connection: string;
  readonly model: string;
  /** The model's state when this seal started (a pause, or a spell active):
   *  what the seal finds counts only while that state lasts. */
  readonly spell: number;
  /** Whether it started as a try of a pause. */
  readonly isTry: boolean;
  layer1Passed: boolean;
}

/** After the first failure, the second, the third and every later one. */
export const SEAL_RETRY_INTERVALS_MS = [3_600_000, 14_400_000, 86_400_000] as const;
/** Active this long without a failure, a model's count starts again. */
export const SEAL_CLEAN_RESET_MS = 86_400_000;
/** Seal requests that failed in a row before sealing pauses. */
export const SEAL_ERRORS_TO_PAUSE = 3;

interface ModelState {
  failures: number;
  activeSince: number;
  errorStreak: number;
  /** Bumped when the model pauses and when it resumes. */
  spell: number;
  pause: { failure: SealFailure; nextTryAt: number; outputTokens?: number } | null;
}

export class CacheSealLedger {
  private readonly models = new Map<string, ModelState>();

  constructor(private readonly now: () => number) {}

  /** Whether the model's steps write their messages for five minutes. */
  shortMarks(connection: string, model: string): boolean {
    return this.state(connection, model).pause === null;
  }

  /** Whether a seal may be sent for the model now: active, or a try is due. */
  sealAllowed(connection: string, model: string): boolean {
    const { pause } = this.state(connection, model);
    return pause === null || this.now() >= pause.nextTryAt;
  }

  /** A seal of the model starting now, or null when none is allowed. */
  startSeal(connection: string, model: string): SealTicket | null {
    if (!this.sealAllowed(connection, model)) return null;
    const state = this.state(connection, model);
    return { connection, model, spell: state.spell, isTry: state.pause !== null, layer1Passed: false };
  }

  /** What the seal's own response said (layer 1). */
  layer1(ticket: SealTicket, outcome: "pass" | "neutral" | SealFailure, outputTokens?: number): void {
    if (outcome === "neutral") return;
    if (outcome === "pass") {
      ticket.layer1Passed = true;
      return;
    }
    this.fail(ticket, outcome, outcome === "output" ? outputTokens : undefined);
  }

  /** What the thread's next step found of the seal (layer 2). */
  layer2(ticket: SealTicket, outcome: "pass" | "excused" | "not_read" | "prefix_changed"): void {
    const state = this.state(ticket.connection, ticket.model);
    if (outcome === "excused") return;
    if (outcome === "pass") {
      if (ticket.layer1Passed && ticket.isTry && state.pause !== null && state.spell === ticket.spell) {
        state.pause = null;
        state.spell += 1;
        state.activeSince = this.now();
      }
      return;
    }
    this.fail(ticket, outcome);
  }

  /** The seal's request failed: three in a row is a failure, and every one
   *  after that until a request succeeds. */
  sendFailed(ticket: SealTicket): void {
    const state = this.state(ticket.connection, ticket.model);
    if (state.spell !== ticket.spell) return;
    state.errorStreak += 1;
    if (state.errorStreak >= SEAL_ERRORS_TO_PAUSE) this.fail(ticket, "errors");
  }

  sendSucceeded(ticket: SealTicket): void {
    this.state(ticket.connection, ticket.model).errorStreak = 0;
  }

  /** The paused models, for Activity's note. */
  pauses(): SealPause[] {
    const out: SealPause[] = [];
    for (const [key, state] of this.models) {
      if (!state.pause) continue;
      const [connection, model] = key.split("\0") as [string, string];
      out.push({
        connection, model, failure: state.pause.failure, nextTryAt: state.pause.nextTryAt,
        ...(state.pause.outputTokens !== undefined ? { outputTokens: state.pause.outputTokens } : {})
      });
    }
    return out;
  }

  private fail(ticket: SealTicket, failure: SealFailure, outputTokens?: number): void {
    const state = this.state(ticket.connection, ticket.model);
    if (state.spell !== ticket.spell) return;
    state.failures += 1;
    state.spell += 1;
    const interval = SEAL_RETRY_INTERVALS_MS[Math.min(state.failures, SEAL_RETRY_INTERVALS_MS.length) - 1]!;
    state.pause = { failure, nextTryAt: this.now() + interval, ...(outputTokens !== undefined ? { outputTokens } : {}) };
  }

  /** The model's state, its count reset once it has been active a day clean. */
  private state(connection: string, model: string): ModelState {
    const key = `${connection}\0${model}`;
    let state = this.models.get(key);
    if (!state) {
      state = { failures: 0, activeSince: this.now(), errorStreak: 0, spell: 0, pause: null };
      this.models.set(key, state);
    }
    if (state.pause === null && state.failures > 0 && this.now() - state.activeSince >= SEAL_CLEAN_RESET_MS) state.failures = 0;
    return state;
  }
}
