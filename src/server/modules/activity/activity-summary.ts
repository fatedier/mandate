import type { Database } from "bun:sqlite";
import type {
  ActivityBucketDto,
  ActivityDailyDto,
  ActivityGroupDto,
  ActivityGroupKey,
  ActivitySummaryResponse
} from "../../../shared/api-contracts.js";
import { unwrapErrorReason } from "../../../shared/error-reason.js";
/** The same guarded read of the fallback marker the log filters on. One
 *  definition on purpose: a breakdown row whose count came from this file and
 *  whose click opened a log built from a different rule would disagree with
 *  itself. Guarded for the reason `ERROR_MESSAGE_SQL` sets out below, and there
 *  the audit that makes the guard unreachable does not hold — `retention.ts`
 *  deliberately leaves unparseable metadata in place. A bad row degrades to
 *  null, which reads as "not known to be a fallback": the count under-reports
 *  rather than attributing a retry to a model that was never reached. */
import { FALLBACK_ATTEMPT_SQL } from "./llm-call-rows.js";

/** Coarse group key width. Wide enough that different providers' errors land in
 *  different groups, narrow enough that 728 failures collapse to ~22 rows
 *  instead of arriving as 2.7 MB of message text. */
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

const BUCKET_ORDER = ["<1s", "1-5s", "5-15s", "15-60s", ">60s"] as const;

type Bucket = (typeof BUCKET_ORDER)[number];

function bucketOf(latencyMs: number): Bucket {
  if (latencyMs < 1000) return "<1s";
  if (latencyMs < 5000) return "1-5s";
  if (latencyMs < 15_000) return "5-15s";
  if (latencyMs < 60_000) return "15-60s";
  return ">60s";
}

/**
 * The percentile the window-function version answered with, kept to the digit.
 *
 * That query ranked ascending from 1 and picked `rn = cast(n * p as int) + 1`.
 * Over the same values sorted ascending, index `floor(n * p)` is the same row —
 * `cast` truncates, and the 1-based rank runs one ahead of the 0-based index.
 * The fallbacks are not decoration: `n * 0.99` on a large group can floor to
 * `n` itself, and an empty group has no reading at all, which the old query
 * reported as a null the caller turned into 0.
 */
function percentile(ascendingValues: number[], p: number): number {
  if (ascendingValues.length === 0) return 0;
  return ascendingValues[Math.floor(ascendingValues.length * p)]
    ?? ascendingValues[ascendingValues.length - 1]!;
}

function windowStart(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Only the columns a group key is built from. Its own type because the reason
 *  query selects these and nothing else — typing that result as a whole scan
 *  row would promise `latency_ms` and hand back undefined. */
interface GroupKeyRow {
  d: string;
  purpose: string;
  provider: string;
  model: string;
  scope_type: string;
  /** `json_extract` of `$.fallbackAttempt`: 1, 0, or null when the call carried
   *  no metadata at all. */
  fallback: number | null;
}

interface ScanRow extends GroupKeyRow {
  status: string;
  latency_ms: number | null;
  ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
}

/**
 * The group a row belongs to, for the requested dimension.
 *
 * `provider / model` is one key rather than two columns because the same model
 * behaves differently behind different providers — on the real store `gpt-5.5`
 * ran 16.3s under one and 36.7s under another.
 *
 * `fallback` reads truthiness, not presence. `candidateIndex` and `attempt` are
 * written to metadata only when a call is not the first candidate's first
 * attempt, so the key is absent on the happy path — but one writer records
 * `fallbackAttempt: candidateIndex > 0`, which is a literal `false` on a retry
 * of the *same* candidate. Presence would file that under "fallback"; truth
 * files it where it belongs.
 */
function groupKeyOf(row: GroupKeyRow, group: ActivityGroupKey): string {
  switch (group) {
    case "model": return `${row.provider} / ${row.model}`;
    case "purpose": return row.purpose || "(none)";
    case "scopeType": return row.scope_type || "(none)";
    case "day": return row.d;
    case "fallback": return row.fallback ? "fallback" : "primary";
  }
}

interface DayAccumulator {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencies: number[];
}

interface GroupAccumulator {
  key: string;
  calls: number;
  failed: number;
  fallbackCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencies: number[];
  reasons: Map<string, number>;
}

/**
 * What this endpoint costs, measured rather than inferred.
 *
 * It used to issue seven statements — six full-window scans, three of them
 * window-function sorts — and the design note's 172ms was one of them. Measured
 * against a copy of the real store (52,261 rows, 34,222 inside the 30-day
 * window) that shape cost 2.5 to 4.7 seconds, and the page took visibly long to
 * open.
 *
 * It is now one narrow scan plus one grouped read of the failures. Interleaved
 * against the old shape on the same handle so drift hit both equally: 2467ms →
 * 572ms at the minimum, 4718ms → 841ms at the median, output byte-identical.
 *
 * The saving is not I/O. A covering index over the filter and sort columns
 * bought about 40%, which is what a read-bound query would give; the rest was
 * `row_number() over (partition by … order by latency_ms)`, three sorts sqlite
 * has to materialise. The same 34k values sort in JS in about two milliseconds.
 * The design note reached the opposite conclusion honestly — it compared the
 * window function against pulling *whole rows* back, 19,831 of them carrying
 * their JSON payloads. Seven narrow columns is a different question, and it
 * never got asked.
 *
 * Cost still tracks rows in the window rather than rows in the table, so the
 * argument against a stats table survives, with more room than before.
 *
 * The grouping dimension is a parameter rather than a second aggregate: the
 * scan is the cost, and every dimension is the same scan with a different key.
 * Grouping is therefore free to add and would not be free to add twice.
 *
 * The four columns the keys need are not free, and one of them is most of it.
 * Interleaved over the same 34,207-row window: 41ms as it stood, 48ms with
 * `provider`, `model` and `scope_type` beside it, 92ms once `json_extract` on
 * the metadata joins them. The extract is 90% of the addition, and it is the
 * only way to read the fallback marker — nothing promotes it to a column.
 */
export function buildActivitySummary(
  db: Database,
  days: number,
  group: ActivityGroupKey
): ActivitySummaryResponse {
  const since = windowStart(days);

  const rows = db.prepare(`
    select substr(created_at, 1, 10) d,
           purpose, status, latency_ms, ttft_ms,
           input_tokens, output_tokens, cache_read_tokens,
           provider, model, scope_type,
           ${FALLBACK_ATTEMPT_SQL} fallback
    from llm_calls
    where created_at > ?
  `).all(since) as ScanRow[];

  const dayByDate = new Map<string, DayAccumulator>();
  const groupsByKey = new Map<string, GroupAccumulator>();
  const bucketCounts = new Map<Bucket, number>();
  const allLatencies: number[] = [];
  // Its own list rather than a parallel array: the column is newer than most of
  // the window, so most rows have a latency and no ttft, and pairing them would
  // read a null as a zero and drag every percentile down.
  const allTtft: number[] = [];

  for (const row of rows) {
    let day = dayByDate.get(row.d);
    if (!day) {
      day = { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, latencies: [] };
      dayByDate.set(row.d, day);
    }
    day.calls += 1;
    if (row.status === "failed") day.failed += 1;
    day.inputTokens += row.input_tokens ?? 0;
    day.outputTokens += row.output_tokens ?? 0;
    day.cacheReadTokens += row.cache_read_tokens ?? 0;

    const key = groupKeyOf(row, group);
    let bucketGroup = groupsByKey.get(key);
    if (!bucketGroup) {
      bucketGroup = {
        key, calls: 0, failed: 0, fallbackCalls: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        latencies: [], reasons: new Map()
      };
      groupsByKey.set(key, bucketGroup);
    }
    bucketGroup.calls += 1;
    if (row.status === "failed") bucketGroup.failed += 1;
    if (row.fallback) bucketGroup.fallbackCalls += 1;
    bucketGroup.inputTokens += row.input_tokens ?? 0;
    bucketGroup.outputTokens += row.output_tokens ?? 0;
    bucketGroup.cacheReadTokens += row.cache_read_tokens ?? 0;

    // A running call counts and has no reading yet.
    if (row.latency_ms !== null) {
      day.latencies.push(row.latency_ms);
      bucketGroup.latencies.push(row.latency_ms);
      allLatencies.push(row.latency_ms);
      const bucket = bucketOf(row.latency_ms);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    }

    if (row.ttft_ms !== null) allTtft.push(row.ttft_ms);
  }

  // Failures only, and grouped in sqlite on a coarse prefix: the messages behind
  // these rows run to thousands of characters each, which is the one column
  // worth keeping out of the scan above.
  //
  // It selects every column a group key is built from rather than the one the
  // caller asked for, so the statement is the same text for all five dimensions
  // and sqlite keeps one prepared plan for it.
  const reasonRows = db.prepare(`
    select substr(created_at, 1, 10) d,
           purpose, provider, model, scope_type,
           ${FALLBACK_ATTEMPT_SQL} fallback,
           substr(${ERROR_MESSAGE_SQL}, 1, ${REASON_KEY_CHARS}) k,
           count(*) n
    from llm_calls
    where created_at > ? and status = 'failed'
    group by d, purpose, provider, model, scope_type, fallback, k
  `).all(since) as Array<GroupKeyRow & { k: string | null; n: number }>;

  for (const row of reasonRows) {
    const target = groupsByKey.get(groupKeyOf(row, group));
    if (!target) continue;
    // Normalising in JS is what lets a coarse SQL key be wrong without showing:
    // two slices that differ only in their tail merge back into one reason.
    const reason = unwrapErrorReason(row.k);
    target.reasons.set(reason, (target.reasons.get(reason) ?? 0) + row.n);
  }

  allLatencies.sort(ascending);
  allTtft.sort(ascending);

  const daily: ActivityDailyDto[] = [...dayByDate.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([date, day]) => {
      day.latencies.sort(ascending);
      return {
        date,
        calls: day.calls,
        failed: day.failed,
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        cacheReadTokens: day.cacheReadTokens,
        p50Ms: percentile(day.latencies, 0.5),
        p95Ms: percentile(day.latencies, 0.95),
        p99Ms: percentile(day.latencies, 0.99)
      };
    });

  // Always all five, in order: a missing bucket is a real reading (zero), and
  // a chart whose rows move between loads cannot be compared against itself.
  const buckets: ActivityBucketDto[] = BUCKET_ORDER.map((bucket) => ({
    bucket,
    calls: bucketCounts.get(bucket) ?? 0
  }));

  const groups: ActivityGroupDto[] = [...groupsByKey.values()]
    // Days read as a timeline, newest first; every other dimension reads as a
    // ranking. Ties break by name so two loads of the same window agree — they
    // used to be left to sqlite, which promises no order for them, and two
    // groups on the same count could swap places between loads.
    .sort((a, b) => (group === "day"
      ? compare(b.key, a.key)
      : b.calls - a.calls || compare(a.key, b.key)))
    .map((entry) => {
      entry.latencies.sort(ascending);
      return {
        key: entry.key,
        label: entry.key,
        calls: entry.calls,
        failed: entry.failed,
        p50Ms: percentile(entry.latencies, 0.5),
        p95Ms: percentile(entry.latencies, 0.95),
        p99Ms: percentile(entry.latencies, 0.99),
        maxMs: entry.latencies.at(-1) ?? 0,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        fallbackCalls: entry.fallbackCalls,
        reasons: [...entry.reasons]
          .map(([reason, calls]) => ({ reason, calls }))
          .sort((a, b) => b.calls - a.calls || compare(a.reason, b.reason))
      };
    });

  return {
    days,
    daily,
    buckets,
    group,
    groups,
    p50Ms: percentile(allLatencies, 0.5),
    p95Ms: percentile(allLatencies, 0.95),
    p99Ms: percentile(allLatencies, 0.99),
    ttft: {
      calls: allTtft.length,
      p50Ms: percentile(allTtft, 0.5),
      p95Ms: percentile(allTtft, 0.95),
      p99Ms: percentile(allTtft, 0.99)
    }
  };
}

function ascending(a: number, b: number): number {
  return a - b;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
