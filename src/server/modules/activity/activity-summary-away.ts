import type { Database } from "bun:sqlite";
import type { ActivityFilterOptionsResponse, ActivityGroupKey, ActivitySummaryResponse } from "../../../shared/api-contracts.js";
import { errorText } from "../../../shared/error-text.js";
import type { ProviderConfig } from "../../config/types.js";
import type { PriceSources } from "../pricing/catalog.js";
import { readParts } from "./activity-parts.js";
import { buildActivitySummary } from "./activity-summary.js";
import { finishFigures } from "./figures-part.js";
import { finishLedger, type LedgerDeps } from "./ledger-part.js";
import { readDreamRuns, readPreviousSpend } from "./ledger-summary.js";
import { activityRange, END_OF_TIME } from "./local-days.js";
import type { CacheVerdict } from "./cache-verdicts.js";
import type { LlmCallFilters } from "./llm-call-store.js";
import type { SliceRow } from "./slice-store.js";
import type { FillResult } from "./activity-rollup.js";
import { loadWindowVerdicts } from "./window-verdicts.js";

/** What the summary reads besides the calls: the window and the reader's days. */
export interface SummaryInput {
  days: number;
  group: ActivityGroupKey;
  /** One end for both halves, so the response counts one window. */
  now: number;
  /** The reader's time zone; its days cut the window. */
  zone: string | null;
  /** One day of the window picked, or the whole window. */
  day: string | null;
}

export type SummaryResult = Omit<ActivitySummaryResponse, "cacheSeal">;

export interface SummaryRequest extends SummaryInput {
  /** The database file, opened read-only by the worker. */
  dbPath: string;
  providers: Record<string, ProviderConfig>;
  /** The lists the catalog in use was built from; null prices nothing. */
  prices: PriceSources | null;
  /** What a kept slice must have been worked out with to be used
   *  (rollupInputs); null works the answer out from every call. */
  inputs: string | null;
}

export interface SummaryAnswer {
  result: SummaryResult;
  /** The whole slices the answer worked out, for the server to keep. */
  built: SliceRow[];
  /** Why the kept slices were set aside for this answer, when they were. */
  fellBack: string | null;
}

/** The slices worked out ahead (fillActivitySlices), on the summary's thread. */
export interface FillRequest {
  dbPath: string;
  providers: Record<string, ProviderConfig>;
  prices: PriceSources | null;
  /** What the slices are worked out with (rollupInputs). */
  inputs: string;
  /** What a passing check against every call is noted as (checkedKey). */
  checked: string;
  now: number;
}

/** The log's filter lists: they read every stored call, so they too are
 *  worked out off the main thread. */
export interface FilterOptionsRequest {
  dbPath: string;
}

/** Each day's calls and tokens over the last days: Personal agent's page's
 *  usage source. Read over the calls, so on the summary's thread too. */
export interface DailyUsageRequest {
  dbPath: string;
  days: number;
}

export interface DailyUsage {
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
}

/** The log's Cache expired view: every step of the window is read and
 *  judged to find them, so on the summary's thread too. */
export interface ExpiredVerdictsRequest {
  dbPath: string;
  /** The window's start: steps created after it are judged. */
  since: string;
}

/** A log view's count: a month of calls weighed one by one (a timer is told
 *  by its turn's reason), so on the summary's thread too. */
export interface CountCallsRequest {
  dbPath: string;
  filters: LlmCallFilters;
}

/** One message to the worker: which job, and its input. */
export type AwayJob =
  | ({ job: "summary" } & SummaryRequest)
  | ({ job: "fill" } & FillRequest)
  | ({ job: "filter-options" } & FilterOptionsRequest)
  | ({ job: "daily-usage" } & DailyUsageRequest)
  | ({ job: "expired-verdicts" } & ExpiredVerdictsRequest)
  | ({ job: "count-calls" } & CountCallsRequest);

type Answer = { ok: true; result: unknown } | { ok: false; message: string };

/** The worker's path in the build: scripts/build-binary.ts makes it an
 *  entrypoint of the binary by this name. */
export const ACTIVITY_SUMMARY_WORKER_ENTRY = "./src/server/modules/activity/activity-summary-worker.ts";

/** In a compiled binary an entrypoint is found by its path in the build (every
 *  module's import.meta.url there is the binary's own); from source, the
 *  worker sits beside this file. */
function workerSpec(): string {
  return import.meta.url.includes("/$bunfs/") ? ACTIVITY_SUMMARY_WORKER_ENTRY : new URL("./activity-summary-worker.ts", import.meta.url).href;
}

/** The Overview's figures and its ledger for one window, from `db`: the
 *  window's calls read once, a part for each of the reader's days, and both
 *  halves finished from the same parts. */
export function summarizeActivity(db: Database, input: SummaryInput, deps: LedgerDeps): SummaryResult {
  // Days cut in the reader's zone, the same for both halves.
  const range = activityRange({ days: input.days, now: input.now, zone: input.zone, day: input.day });
  const until = range.until ?? END_OF_TIME;
  const parts = [...readParts(db, { since: range.since, until }, deps, (createdAt) => range.clock.dayOf(createdAt))];
  return {
    ...finishFigures(
      parts.map(([day, part]) => ({ day, figures: part.figures })),
      { days: input.days, group: input.group, today: range.clock.dayOf(new Date(input.now).toISOString()), pickedDay: range.day }
    ),
    ledger: finishLedger(
      parts.map(([day, part]) => ({ day, ledger: part.ledger })),
      { dreamRuns: readDreamRuns(db, range.since, until), previous: readPreviousSpend(db, range.previousSince, range.previousUntil) }
    ),
    day: range.day
  };
}

/** summarizeActivity in one read transaction. Apart from the server's
 *  connection, which goes on writing calls, the two halves would each read
 *  their own snapshot and count different calls; in one, they read the
 *  database as its first read found it (WAL). */
export function summarizeActivitySnapshot(db: Database, input: SummaryInput, deps: LedgerDeps): SummaryResult {
  // A plain BEGIN, deferred: the snapshot is the first read's.
  return db.transaction(() => summarizeActivity(db, input, deps))();
}

/**
 * summarizeActivity in a worker of its own, so a month of calls never holds
 * the main thread: every stored call in the window is read and worked out on
 * each read. The worker opens the database read-only beside the server's own
 * connection (WAL readers wait on no writer) and builds the catalog from the
 * lists the server prices with. A worker per read: starting one costs a few
 * milliseconds beside the read itself, and nothing outlives it. Given
 * `inputs`, it reads the hours kept as slices instead of their calls
 * (activity-rollup.ts) and hands back the ones it had to work out.
 */
export function summarizeActivityAway(request: SummaryRequest): Promise<SummaryAnswer> {
  return runAway<SummaryAnswer>({ job: "summary", ...request });
}

/** fillActivitySlices in a worker of its own, in one read transaction. */
export function fillActivityAway(request: FillRequest): Promise<FillResult> {
  return runAway<FillResult>({ job: "fill", ...request });
}

/** Each day's usage over the last `days`, on the thread it is read on. */
export function dailyUsage(db: Database, days: number): DailyUsage[] {
  return buildActivitySummary(db, days, "day").daily.map((day) => ({
    day: day.date, inputTokens: day.inputTokens, outputTokens: day.outputTokens, cacheReadTokens: day.cacheReadTokens, calls: day.calls
  }));
}

/** dailyUsage on the summary's thread. */
export function dailyUsageAway(request: DailyUsageRequest): Promise<DailyUsage[]> {
  return runAway<DailyUsage[]>({ job: "daily-usage", ...request });
}

/** The window's expired steps and their verdicts, in one read transaction:
 *  the steps and the calls before them as one snapshot (WAL). */
export function expiredVerdicts(db: Database, since: string): Array<[string, CacheVerdict]> {
  return db.transaction(() => [...loadWindowVerdicts(db, since)].filter(([, verdict]) => verdict.kind === "expired"))();
}

/** expiredVerdicts on the summary's thread. */
export async function expiredVerdictsAway(request: ExpiredVerdictsRequest): Promise<Map<string, CacheVerdict>> {
  return new Map(await runAway<Array<[string, CacheVerdict]>>({ job: "expired-verdicts", ...request }));
}

/** How many calls the filters select, on the summary's thread. */
export function countCallsAway(request: CountCallsRequest): Promise<number> {
  return runAway<number>({ job: "count-calls", ...request });
}

/** listActivityFilterOptions on the summary's thread. */
export function listFilterOptionsAway(request: FilterOptionsRequest): Promise<ActivityFilterOptionsResponse> {
  return runAway<ActivityFilterOptionsResponse>({ job: "filter-options", ...request });
}

function runAway<T>(job: AwayJob): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSpec());
    worker.onmessage = (event: MessageEvent<Answer>) => {
      worker.terminate();
      const answer = event.data;
      if (answer.ok) resolve(answer.result as T);
      else reject(new Error(answer.message));
    };
    worker.onerror = (event: ErrorEvent) => {
      worker.terminate();
      reject(new Error(errorText(event.error ?? event.message)));
    };
    worker.postMessage(job);
  });
}
