import type { Database } from "bun:sqlite";
import type { ActivityGroupKey, ActivitySummaryResponse } from "../../../shared/api-contracts.js";
import { unwrapErrorReason } from "../../../shared/error-reason.js";
import { addFigureCall, addFigureReason, finishFigures, newFiguresPart, type FiguresPart, type GroupKeyRow, type SummaryCall } from "./figures-part.js";
/** The same guarded read of the fallback marker the log filters on. One
 *  definition on purpose: a breakdown row whose count came from this file and
 *  whose click opened a log built from a different rule would disagree with
 *  itself. Guarded for the reason `ERROR_MESSAGE_SQL` sets out below, and there
 *  the audit that makes the guard unreachable does not hold — `retention.ts`
 *  deliberately leaves unparseable metadata in place. A bad row degrades to
 *  null, which reads as "not known to be a fallback": the count under-reports
 *  rather than attributing a retry to a model that was never reached. */
import { FALLBACK_ATTEMPT_SQL, PROVIDER_KEY_SQL } from "./llm-call-rows.js";
import { activityRange, END_OF_TIME, type ActivityRange } from "./local-days.js";

export type { SummaryCall } from "./figures-part.js";

/** Coarse group key width. Wide enough that different providers' errors land in
 *  different groups, narrow enough that a window's failures collapse to a few rows
 *  instead of arriving as megabytes of message text. */
const REASON_KEY_CHARS = 200;

/**
 * The failure message a row records, or the whole column when it holds no
 * `message` key.
 *
 * json_valid() has to guard the extract rather than the row: json_extract()
 * *raises* "malformed JSON text" instead of answering null, so a single
 * unparseable `error_json` would abort the statement and take the whole
 * Overview down with a 500. CASE evaluates only the branch it selects, which
 * is what makes the guard hold — under a bare coalesce() the extract is still
 * reached. A guarded bad row degrades to its raw text, which is what a reader
 * wants to see anyway.
 *
 * Every write goes through `jsonOrNull` (llm-call-rows.ts) and so is
 * JSON.stringify output, so this is unreachable today — by audit of one
 * writer, not by anything the schema enforces.
 */
const ERROR_MESSAGE_SQL = `coalesce(
    case when json_valid(error_json) then json_extract(error_json, '$.message') end,
    error_json
  )`;

/** The failures of one key in one minute, by reason. */
export interface FigureReasonRow extends GroupKeyRow {
  /** `created_at` to the minute: no zone moves its offset inside one, so each
   *  minute falls on one of the reader's days (and in one hour). */
  minute: string;
  reason: string;
  calls: number;
}

/**
 * The reasons of the calls that failed after `since` and before `until`.
 *
 * Failures only, and grouped in sqlite on a coarse prefix: the messages
 * behind these rows run to thousands of characters each, which is the one
 * column worth keeping out of the scan of every call.
 *
 * It selects every column a group key is built from rather than the one a
 * caller asked for, so the statement is the same text for all five
 * dimensions.
 */
export function readFigureReasons(db: Database, since: string, until: string): FigureReasonRow[] {
  const rows = db.prepare(`
    select substr(created_at, 1, 16) minute,
           purpose, ${PROVIDER_KEY_SQL} provider_name, model, scope_type,
           ${FALLBACK_ATTEMPT_SQL} fallback,
           substr(${ERROR_MESSAGE_SQL}, 1, ${REASON_KEY_CHARS}) k,
           count(*) calls
    from llm_calls
    where created_at > ? and created_at < ? and status = 'failed'
    group by minute, purpose, ${PROVIDER_KEY_SQL}, model, scope_type, fallback, k
  `).all(since, until) as Array<GroupKeyRow & { minute: string; k: string | null; calls: number }>;
  // Normalising in JS is what lets a coarse SQL key be wrong without showing:
  // two slices that differ only in their tail merge back into one reason.
  return rows.map(({ k, ...row }) => ({ ...row, reason: unwrapErrorReason(k) }));
}

/**
 * What this endpoint costs.
 *
 * It is one narrow scan plus one grouped read of the failures. Separate
 * full-window scans, and window-function sorts in SQL, cost seconds on a large
 * database and the page opened visibly late.
 *
 * The cost is not I/O: `row_number() over (partition by … order by latency_ms)`
 * makes sqlite materialise a sort, where the same values sort in JS in a few
 * milliseconds. Pulling back seven narrow columns, not whole rows with their JSON
 * payloads, is what keeps that cheap.
 *
 * Cost still tracks rows in the window rather than rows in the table.
 *
 * The grouping dimension is a parameter rather than a second aggregate: the
 * scan is the cost, and every dimension is the same scan with a different key.
 * Grouping is therefore free to add and would not be free to add twice.
 *
 * The four columns the keys need are not free, and one of them is most of it:
 * the scan costs a little more with `provider`, `model` and `scope_type` beside
 * it, and twice as much once `json_extract` on the metadata joins them. The
 * extract is the only way to read the fallback marker — nothing promotes it
 * to a column — so the scan makes it only for the grouping that reads it.
 *
 * The calls are summed a day of the reader's at a time and the days merged
 * (figures-part.ts): the window whole is worked out as its parts are.
 *
 * `calls`: the window's calls already read (for the ledger of the same
 * answer); with them there is no scan here at all.
 */
export function buildActivitySummary(
  db: Database,
  days: number,
  group: ActivityGroupKey,
  /** The window's end, shared with the ledger so one response counts one window. */
  now = Date.now(),
  /** Which calls, and whose days: shared with the ledger for the same reason. */
  range: ActivityRange = activityRange({ days, now }),
  calls?: readonly SummaryCall[]
): Omit<ActivitySummaryResponse, "ledger"> {
  const { since, clock } = range;
  // An open end reads as one past any stored time.
  const until = range.until ?? END_OF_TIME;

  // The scan below reads the fallback marker only when grouping by it; calls
  // handed in carry it whatever the grouping.
  const marked = calls !== undefined || group === "fallback";
  const rows = calls ?? db.prepare(`
    select created_at,
           purpose, status, latency_ms, ttft_ms,
           input_tokens, output_tokens, cache_read_tokens,
           cost_micros, cost_source,
           ${PROVIDER_KEY_SQL} provider_name, model, scope_type,
           ${marked ? FALLBACK_ATTEMPT_SQL : "null"} fallback
    from llm_calls
    where created_at > ? and created_at < ?
  `).all(since, until) as SummaryCall[];

  // A call's day is the reader's, so a group by day agrees with the chart.
  const byDay = new Map<string, FiguresPart>();
  for (const row of rows) {
    const date = clock.dayOf(row.created_at);
    let part = byDay.get(date);
    if (!part) {
      part = newFiguresPart();
      byDay.set(date, part);
    }
    addFigureCall(part, row);
  }
  for (const row of readFigureReasons(db, since, until)) {
    const part = byDay.get(clock.dayOf(row.minute));
    // A reason goes to its call's key: without the marker read, the calls
    // were keyed without it.
    if (part) addFigureReason(part, marked ? row : { ...row, fallback: null }, row.reason, row.calls);
  }

  return finishFigures(
    [...byDay].map(([day, figures]) => ({ day, figures })),
    { days, group, today: clock.dayOf(new Date(now).toISOString()), pickedDay: range.day }
  );
}
