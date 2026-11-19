import type { Database } from "bun:sqlite";
import type { ActivityLedgerDto } from "../../../shared/api/activity.js";
import { verdictsOf } from "./activity-parts.js";
import { addLedgerCall, finishLedger, newLedgerPart, type LedgerDeps, type LedgerPart } from "./ledger-part.js";
import { activityRange, END_OF_TIME, type ActivityRange } from "./local-days.js";
import { readWindowCalls, type WindowCall } from "./window-calls.js";

export type { LedgerDeps } from "./ledger-part.js";

/** Dream runs started after `since` and before `until`: counted from their
 *  own table, a run that left no calls included. */
export function readDreamRuns(db: Database, since: string, until: string): number {
  return (db.prepare("select count(*) n from memory_dream_runs where started_at > ? and started_at < ?").get(since, until) as { n: number }).n;
}

/** The spend of the calls created after `since`, up to and including `until`,
 *  and how many calls it is: the period a window's spend is compared with. */
export function readPreviousSpend(db: Database, since: string, until: string): { micros: number; calls: number } {
  const row = db.prepare(`select coalesce(sum(cost_micros), 0) s, count(*) n from llm_calls
    where created_at > ? and created_at <= ? and cost_source in ('reported', 'your_price', 'price_as', 'list', 'catalog')`).get(since, until) as { s: number; n: number };
  return { micros: row.s, calls: row.n };
}

/**
 * The Overview's ledger for the last `days` days: spend per day and the part
 * the cache-expired calls paid on top; who spent it; the cache verdicts; what
 * the spend is made of; and what woke the agents. Worked out from the stored
 * calls when the page reads, a day of the reader's at a time and the days
 * merged (ledger-part.ts): the window whole is worked out as its parts are.
 * `calls`: the window's calls already read (for the figures of the same
 * answer).
 */
export function buildActivityLedger(
  db: Database,
  days: number,
  deps: LedgerDeps,
  now = Date.now(),
  range: ActivityRange = activityRange({ days, now }),
  calls?: readonly WindowCall[]
): ActivityLedgerDto {
  const { since, clock } = range;
  const until = range.until ?? END_OF_TIME;

  const rows = calls ?? readWindowCalls(db, since, until);
  // Verdicts, judged as the Logs rows judge them.
  const verdicts = verdictsOf(db, rows, since);
  const byDay = new Map<string, LedgerPart>();
  for (const row of rows) {
    const day = clock.dayOf(row.created_at);
    let part = byDay.get(day);
    if (!part) {
      part = newLedgerPart();
      byDay.set(day, part);
    }
    addLedgerCall(part, row, verdicts.get(row.id), deps);
  }
  return finishLedger(
    [...byDay].map(([day, ledger]) => ({ day, ledger })),
    { dreamRuns: readDreamRuns(db, since, until), previous: readPreviousSpend(db, range.previousSince, range.previousUntil) }
  );
}
