import type { Database } from "bun:sqlite";
import { readFigureReasons } from "./activity-summary.js";
import { addFigureCall, addFigureReason, newFiguresPart, type FiguresPart } from "./figures-part.js";
import { addLedgerCall, newLedgerPart, type LedgerDeps, type LedgerPart } from "./ledger-part.js";
import { readWindowCalls, type WindowCall } from "./window-calls.js";
import { threadStepFromRow, verdictsForSteps, type ThreadStep } from "./window-verdicts.js";
import type { CacheVerdict } from "./cache-verdicts.js";

/** What a set of calls adds to both halves of the Overview's answer. */
export interface ActivityPart {
  figures: FiguresPart;
  ledger: LedgerPart;
}

/** The calls a later one can be judged against, or that are judged: a
 *  thread's steps, compactions and cache seals. */
function stepsOf(calls: readonly WindowCall[]): ThreadStep[] {
  const steps: ThreadStep[] = [];
  for (const call of calls) {
    if (call.scope_type === "agent_thread" && call.scope_id && (call.purpose === "agent_wake_step" || call.purpose === "agent_compression" || call.purpose === "agent_cache_seal")) {
      steps.push(threadStepFromRow(call));
    }
  }
  return steps;
}

/** The verdicts of the calls created after `since`, judged as the Logs rows
 *  judge them: each thread's first against its last anchor at or before
 *  `since`. */
export function verdictsOf(db: Database, calls: readonly WindowCall[], since: string): Map<string, CacheVerdict> {
  return verdictsForSteps(db, stepsOf(calls), since);
}

/**
 * The calls created after `since` and before `until`, read once, each added
 * to the part `keyOf` names for its `created_at` (the failures' reasons by
 * their minute). The parts come in the order their first call was read.
 *
 * `since` is not in the range, so a run that begins on an instant is read
 * from the millisecond before it: its first call is then judged against an
 * anchor before that instant, never against itself.
 */
export function readParts(
  db: Database,
  range: { since: string; until: string },
  deps: LedgerDeps,
  keyOf: (createdAt: string) => string
): Map<string, ActivityPart> {
  const calls = readWindowCalls(db, range.since, range.until);
  const verdicts = verdictsOf(db, calls, range.since);
  const parts = new Map<string, ActivityPart>();
  for (const call of calls) {
    const key = keyOf(call.created_at);
    let part = parts.get(key);
    if (!part) {
      part = { figures: newFiguresPart(), ledger: newLedgerPart() };
      parts.set(key, part);
    }
    addFigureCall(part.figures, call);
    addLedgerCall(part.ledger, call, verdicts.get(call.id), deps);
  }
  for (const row of readFigureReasons(db, range.since, range.until)) {
    const part = parts.get(keyOf(row.minute));
    if (part) addFigureReason(part.figures, row, row.reason, row.calls);
  }
  return parts;
}
