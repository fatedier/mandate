import type { Database } from "bun:sqlite";
import { errorText } from "../../../shared/error-text.js";
import type { ProviderConfig } from "../../config/types.js";
import { sha256 } from "../../platform/crypto/hash.js";
import type { PriceCatalog } from "../pricing/catalog.js";
import { priceSettingsOf } from "../pricing/pricing-pass.js";
import { readParts, type ActivityPart } from "./activity-parts.js";
import { summarizeActivity, summarizeActivitySnapshot, type SummaryAnswer, type SummaryInput, type SummaryResult } from "./activity-summary-away.js";
import { finishFigures, newFiguresPart } from "./figures-part.js";
import { finishLedger, newLedgerPart, type LedgerDeps } from "./ledger-part.js";
import { readDreamRuns, readPreviousSpend } from "./ledger-summary.js";
import { activityRange, END_OF_TIME, nextDate, type ActivityRange } from "./local-days.js";
import { planSlices, type PlannedRead } from "./slice-plan.js";
import { sliceOf, sliceStartMs } from "./slice-schema.js";
import { decodeSlice, encodeSlice, SLICE_LAYOUT, SLICES_KEPT_DAYS, type SliceRow } from "./slice-store.js";

/**
 * The Overview's answer merged from kept slices and what is new.
 *
 * A month's calls barely change once they finish, so each hour's part is
 * kept (slice-store.ts) and an answer reads from the calls only what no
 * valid kept slice covers: the window's two ends, and the slices a change
 * has made out of date (slice-plan.ts). The answer is the one working the
 * window out from every call gives, for the same snapshot of the database.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Whole slices a fill reads from the calls in one go: a week of them, so
 *  two months of calls are never held at once. */
const FILL_RUN_SLICES = 7 * 24;
/** The window whose answer a fill checks both ways: the page's longest usual one. */
const CHECK_DAYS = 30;

/**
 * What a slice's facts were worked out with besides its calls: the layout of
 * the kept facts, the price lists (by their content) and each connection's
 * price settings. Slices kept under other inputs are worked out again.
 */
export function rollupInputs(catalog: PriceCatalog | null, providers: Record<string, ProviderConfig>): string {
  return `${SLICE_LAYOUT}|${catalog ? catalog.dataInfo().version : "none"}|${sha256(JSON.stringify(priceSettingsOf(providers)))}`;
}

/**
 * What a month's answer from the slices found to be the one from every call
 * is noted as: the inputs, and the build that worked the slices out. The
 * inputs name the prices and the layout of the kept facts; how the facts are
 * worked out from a call is the code's, and a new build is checked once.
 */
export function checkedKey(inputs: string, build: string): string {
  return `${inputs}|${build}`;
}

/** The first slice no longer kept is the one before this. */
export function sliceHorizon(now: number): string {
  return sliceOf(new Date(now - SLICES_KEPT_DAYS * DAY_MS).toISOString());
}

/** Whether every day of the window starts on the hour in the reader's zone:
 *  only then does each hour's slice lie inside one of their days. */
function daysStartOnTheHour(range: ActivityRange, now: number): boolean {
  const { clock } = range;
  const last = nextDate(clock.dayOf(range.until ?? new Date(now).toISOString()));
  for (let date = clock.dayOf(range.since); date <= last; date = nextDate(date)) {
    if (clock.startOf(date) % HOUR_MS !== 0) return false;
  }
  return true;
}

interface KeptSpend { start: string; builtSeq: number; inputs: string; spendMicros: number; spendCalls: number }

type Run = PlannedRead["build"][number];

/** One run's calls as parts by slice, and its whole slices as rows to keep
 *  (none older than `horizon`). */
function readRun(db: Database, run: Run, deps: LedgerDeps, built: { seq: number; inputs: string; horizon: string }): { read: Map<string, ActivityPart>; rows: SliceRow[] } {
  const read = readParts(db, { since: run.since, until: run.until }, deps, sliceOf);
  const rows: SliceRow[] = [];
  for (const slice of run.whole) {
    if (slice < built.horizon) continue;
    // An hour with no call is kept too: it is then known to be empty.
    rows.push(encodeSlice(slice, read.get(slice) ?? { figures: newFiguresPart(), ledger: newLedgerPart() }, built.seq, built.inputs));
  }
  return { read, rows };
}

/**
 * The answer for `input`, and the whole slices it had to work out, to keep.
 * Runs inside the caller's read transaction: the kept slices, the changes and
 * the calls are then one snapshot.
 */
export function summarizeActivityRolled(
  db: Database, input: SummaryInput, deps: LedgerDeps, inputs: string,
  /** Slices worked out in this snapshot and not kept yet: read as if they were. */
  fresh: readonly SliceRow[] = []
): { result: SummaryResult; built: SliceRow[] } {
  const range = activityRange({ days: input.days, now: input.now, zone: input.zone, day: input.day });
  if (!daysStartOnTheHour(range, input.now)) return { result: summarizeActivity(db, input, deps), built: [] };

  const { clock } = range;
  const until = range.until ?? END_OF_TIME;
  const state = db.prepare("select seq, floor from activity_rollup_state where id = 1").get() as { seq: number; floor: number };
  const changes = db.prepare("select start, seq from activity_slice_changes order by start").all() as Array<{ start: string; seq: number }>;
  const lastSlice = sliceOf(range.until ?? new Date(input.now).toISOString());
  const firstSlice = sliceOf(range.since);
  const kept = db.prepare("select start, built_seq builtSeq, inputs, facts, vals from activity_slices where start > ? and start <= ?")
    .all(firstSlice, lastSlice) as Array<Pick<SliceRow, "start" | "builtSeq" | "inputs" | "facts" | "vals">>;
  const keptAt = new Map(kept.map((row) => [row.start, row]));
  for (const row of fresh) if (row.start > firstSlice && row.start <= lastSlice) keptAt.set(row.start, row);
  const plan = planSlices({ since: range.since, until: range.until, now: input.now, kept: [...keptAt.values()], changes, state, inputs });

  const parts: Array<[string, ActivityPart]> = plan.use.map((slice) => [slice, decodeSlice(keptAt.get(slice)!)]);
  const building = { seq: state.seq, inputs, horizon: sliceHorizon(input.now) };
  const built: SliceRow[] = [];
  for (const run of plan.build) {
    const { read, rows } = readRun(db, run, deps, building);
    for (const entry of read) parts.push(entry);
    for (const row of rows) built.push(row);
  }
  // Oldest first: a slice's name sorts as its hour does.
  parts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dayOf = (slice: string) => clock.dayOf(`${slice}:00:00.000Z`);

  // The period before: the kept slices' spend, and the calls of what is not kept.
  const previousEnd = new Date(Date.parse(range.previousUntil) + 1).toISOString();
  const keptBefore = db.prepare("select start, built_seq builtSeq, inputs, spend_micros spendMicros, spend_calls spendCalls from activity_slices where start > ? and start <= ?")
    .all(sliceOf(range.previousSince), sliceOf(previousEnd)) as KeptSpend[];
  const spendAt = new Map(keptBefore.map((row) => [row.start, row]));
  for (const row of fresh) if (row.start > sliceOf(range.previousSince) && row.start <= sliceOf(previousEnd)) spendAt.set(row.start, row);
  const before = planSlices({ since: range.previousSince, until: previousEnd, now: input.now, kept: [...spendAt.values()], changes, state, inputs });
  const previous = { micros: 0, calls: 0 };
  for (const slice of before.use) {
    previous.micros += spendAt.get(slice)!.spendMicros;
    previous.calls += spendAt.get(slice)!.spendCalls;
  }
  for (const run of before.build) {
    // A run ends before `until`; the sum reads up to and including its end.
    const sum = readPreviousSpend(db, run.since, new Date(Date.parse(run.until) - 1).toISOString());
    previous.micros += sum.micros;
    previous.calls += sum.calls;
  }

  return {
    result: {
      ...finishFigures(
        parts.map(([slice, part]) => ({ day: dayOf(slice), figures: part.figures })),
        { days: input.days, group: input.group, today: clock.dayOf(new Date(input.now).toISOString()), pickedDay: range.day }
      ),
      ledger: finishLedger(
        parts.map(([slice, part]) => ({ day: dayOf(slice), ledger: part.ledger })),
        { dreamRuns: readDreamRuns(db, range.since, until), previous }
      ),
      day: range.day
    },
    built
  };
}

export interface FillResult {
  /** The slices worked out, to keep. */
  built: SliceRow[];
  /** A month's answer from the slices against the one from every call, when
   *  that check was owed under these inputs; null when it had been made. */
  compared: null | { same: boolean; where: string | null };
}

/** A run cut into pieces of at most a week of whole slices. */
function* weeks(run: Run): Generator<Run> {
  for (let i = 0; i === 0 || i < run.whole.length; i += FILL_RUN_SLICES) {
    const whole = run.whole.slice(i, i + FILL_RUN_SLICES);
    const next = run.whole[i + FILL_RUN_SLICES];
    yield {
      // `since` is not in a read: the millisecond before the piece's first hour.
      since: i === 0 ? run.since : new Date(sliceStartMs(whole[0]!) - 1).toISOString(),
      until: next === undefined ? run.until : new Date(sliceStartMs(next)).toISOString(),
      whole
    };
  }
}

/** The first place two answers, as parsed JSON, are not the same. */
function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const at = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (at !== null) return at;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const at = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      if (at !== null) return at;
    }
    return null;
  }
  return path || "the whole answer";
}

/**
 * The answer's work with no answer: every whole slice of the days kept that
 * is missing or out of date, worked out to keep. The first time under
 * `inputs` and this build (a first start, other prices, another layout, a
 * new binary) a month's answer
 * is also worked out both ways in this snapshot, from the slices and from
 * every call, and the two compared: what stands between a slice wrongly
 * trusted and a wrong amount on the page. Runs inside the caller's read
 * transaction.
 */
export function fillActivitySlices(
  db: Database,
  /** `checked`: what the check is noted as when it passes (checkedKey); it is
   *  made unless the database notes this already. */
  input: { now: number; checked: string },
  deps: LedgerDeps,
  inputs: string
): FillResult {
  const state = db.prepare("select seq, floor, checked from activity_rollup_state where id = 1").get() as { seq: number; floor: number; checked: string | null };
  const horizon = sliceHorizon(input.now);
  // From the first slice kept to the hour under way: both ends on the hour,
  // so every slice between them is whole.
  const since = new Date(sliceStartMs(horizon) - 1).toISOString();
  const until = new Date(Math.floor(input.now / HOUR_MS) * HOUR_MS).toISOString();
  const changes = db.prepare("select start, seq from activity_slice_changes order by start").all() as Array<{ start: string; seq: number }>;
  const kept = db.prepare("select start, built_seq builtSeq, inputs from activity_slices where start >= ?").all(horizon) as Array<{ start: string; builtSeq: number; inputs: string }>;
  const plan = planSlices({ since, until, now: input.now, kept, changes, state, inputs });
  const building = { seq: state.seq, inputs, horizon };
  const built: SliceRow[] = [];
  for (const run of plan.build) {
    for (const piece of weeks(run)) {
      for (const row of readRun(db, piece, deps, building).rows) built.push(row);
    }
  }
  if (state.checked === input.checked) return { built, compared: null };

  // In a zone whose days start on the hour, so the slices are what is read.
  const month: SummaryInput = { days: CHECK_DAYS, group: "purpose", now: input.now, zone: "UTC", day: null };
  const fromSlices = JSON.stringify(summarizeActivityRolled(db, month, deps, inputs, built).result);
  const fromCalls = JSON.stringify(summarizeActivity(db, month, deps));
  if (fromSlices === fromCalls) return { built, compared: { same: true, where: null } };
  return { built, compared: { same: false, where: firstDifference(JSON.parse(fromCalls), JSON.parse(fromSlices)) ?? "the order of its fields" } };
}

/**
 * One answer, in one read transaction: from the kept slices when `inputs`
 * says what they must have been worked out with, from every call otherwise.
 * Anything that goes wrong among the slices answers from every call instead,
 * and says what it was.
 */
export function answerSummary(db: Database, input: SummaryInput, deps: LedgerDeps, inputs: string | null): SummaryAnswer {
  if (inputs !== null) {
    try {
      // A plain BEGIN, deferred: slices, changes and calls are the first read's snapshot.
      return { ...db.transaction(() => summarizeActivityRolled(db, input, deps, inputs))(), fellBack: null };
    } catch (error) {
      return { result: summarizeActivitySnapshot(db, input, deps), built: [], fellBack: errorText(error) };
    }
  }
  return { result: summarizeActivitySnapshot(db, input, deps), built: [], fellBack: null };
}
