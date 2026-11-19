import type {
  ActivityDailyDto,
  ActivityGroupDto,
  ActivityGroupKey,
  ActivitySpendDto,
  ActivitySummaryResponse,
  ActivityTrendDto,
  ActivityTrendSeriesDto
} from "../../../shared/api-contracts.js";
import { chartDates } from "./local-days.js";

/**
 * The Overview's figures, worked out in parts that merge.
 *
 * A part is what a set of calls adds, summed at the finest key any grouping
 * reads (purpose, connection, model, scope type, fallback or not) with the
 * values its percentiles need kept beside the sums. Any number of parts,
 * each lying within one of the reader's days, finish into the figures the
 * same calls would give read as one: the window whole is one part a day, a
 * kept slice is the part of its hour.
 */

/** Only the columns a group key is built from. */
export interface GroupKeyRow {
  purpose: string;
  /** The connection's name (PROVIDER_KEY_SQL). */
  provider_name: string | null;
  model: string;
  scope_type: string;
  /** `$.fallbackAttempt` of the metadata, read for its truth: null when the
   *  call carried no metadata at all, or the grouping does not ask for it. */
  fallback: unknown;
}

/** A call as the figures read it. */
export interface SummaryCall extends GroupKeyRow {
  created_at: string;
  status: string;
  latency_ms: number | null;
  ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_micros: number | null;
  cost_source: string | null;
}

/** Sources whose amount is spend: a reported charge or an estimate. */
const SPEND_SOURCES = new Set(["reported", "your_price", "price_as", "list", "catalog"]);

/** The calls of one key in a part. */
export interface FigureTuple {
  purpose: string;
  provider_name: string | null;
  model: string;
  scope_type: string;
  fallback: boolean;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  spendMicros: number;
  reportedMicros: number;
  estimated: boolean;
  pricedCalls: number;
  unpricedCalls: number;
  includedCalls: number;
  pendingCalls: number;
  /** Every finished call's time; only the calls that recorded a first
   *  token; and each answered call's output tokens with its time, a speed
   *  once divided. Whole numbers, as stored. */
  latencies: ArrayLike<number>;
  ttfts: ArrayLike<number>;
  rateOutputs: ArrayLike<number>;
  rateLatencies: ArrayLike<number>;
  /** Failure reasons, as the figures name them, with their counts. */
  reasons: Map<string, number>;
}

export interface FiguresPart {
  /** In the order their first call came. */
  tuples: FigureTuple[];
}

/** A part being added to finds its tuples by key; one read back from a kept
 *  slice has none until it is added to. */
const indexes = new WeakMap<FiguresPart, Map<string, FigureTuple>>();

/** Texts that cannot be told apart once joined are kept apart by a
 *  character no name holds; no connection name stands in for a missing one. */
function tupleKey(row: GroupKeyRow): string {
  return `${row.purpose}\u0000${row.provider_name ?? "\u0001"}\u0000${row.model}\u0000${row.scope_type}\u0000${row.fallback ? 1 : 0}`;
}

function indexOf(part: FiguresPart): Map<string, FigureTuple> {
  let index = indexes.get(part);
  if (!index) {
    index = new Map(part.tuples.map((tuple) => [tupleKey(tuple), tuple]));
    indexes.set(part, index);
  }
  return index;
}

export function newFiguresPart(): FiguresPart {
  return { tuples: [] };
}

/** Adds one call. The part must be one under construction: its values are
 *  plain arrays. */
export function addFigureCall(part: FiguresPart, row: SummaryCall): void {
  const index = indexOf(part);
  const key = tupleKey(row);
  let tuple = index.get(key);
  if (!tuple) {
    tuple = {
      purpose: row.purpose, provider_name: row.provider_name, model: row.model, scope_type: row.scope_type, fallback: Boolean(row.fallback),
      calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      spendMicros: 0, reportedMicros: 0, estimated: false, pricedCalls: 0, unpricedCalls: 0, includedCalls: 0, pendingCalls: 0,
      latencies: [], ttfts: [], rateOutputs: [], rateLatencies: [], reasons: new Map()
    };
    index.set(key, tuple);
    part.tuples.push(tuple);
  }
  tuple.calls += 1;
  if (row.status === "failed") tuple.failed += 1;
  tuple.inputTokens += row.input_tokens ?? 0;
  tuple.outputTokens += row.output_tokens ?? 0;
  tuple.cacheReadTokens += row.cache_read_tokens ?? 0;

  // Spend: reported and estimated amounts; Unpriced counted, never added
  // as 0; Included and Free are not spend.
  if (row.cost_source && SPEND_SOURCES.has(row.cost_source)) {
    const micros = row.cost_micros ?? 0;
    tuple.spendMicros += micros;
    tuple.pricedCalls += 1;
    if (row.cost_source === "reported") tuple.reportedMicros += micros;
    else tuple.estimated = true;
  } else if (row.cost_source === "unpriced") {
    tuple.unpricedCalls += 1;
  } else if (row.cost_source === "included") {
    tuple.includedCalls += 1;
  } else if (row.cost_source === null && row.status !== "running") {
    tuple.pendingCalls += 1;
  }

  // A running call counts and has no reading yet.
  if (row.latency_ms !== null) (tuple.latencies as number[]).push(row.latency_ms);
  if (row.ttft_ms !== null) (tuple.ttfts as number[]).push(row.ttft_ms);
  // A call that answered: its output over its whole time.
  if (row.status === "succeeded" && row.output_tokens && row.latency_ms) {
    (tuple.rateOutputs as number[]).push(row.output_tokens);
    (tuple.rateLatencies as number[]).push(row.latency_ms);
  }
}

/** Adds `calls` failures of one reason to the key's tuple. A key with no
 *  call in the part has no tuple, and its reasons nowhere to show. */
export function addFigureReason(part: FiguresPart, key: GroupKeyRow, reason: string, calls: number): void {
  const tuple = indexOf(part).get(tupleKey(key));
  if (tuple) tuple.reasons.set(reason, (tuple.reasons.get(reason) ?? 0) + calls);
}

/**
 * The group a tuple belongs to, for the requested dimension.
 *
 * `provider / model` is one key rather than two columns because the same model
 * behaves differently behind different providers — one model can take more
 * than twice as long under one as under another.
 *
 * `fallback` reads truthiness, not presence. `candidateIndex` and `attempt` are
 * written to metadata only when a call is not the first candidate's first
 * attempt, so the key is absent on the happy path — and `llmAttemptMetadata`
 * records `fallbackAttempt: candidateIndex > 0`, which is a literal `false` on
 * a retry of the *same* candidate. Presence would file that under "fallback";
 * truth files it where it belongs.
 */
function groupKeyOf(tuple: FigureTuple, group: ActivityGroupKey, day: string): string {
  switch (group) {
    case "model": return `${tuple.provider_name} / ${tuple.model}`;
    case "purpose": return tuple.purpose || "(none)";
    case "scopeType": return tuple.scope_type || "(none)";
    case "day": return day;
    case "fallback": return tuple.fallback ? "fallback" : "primary";
  }
}

/**
 * The value at index `floor(n * p)` of the values sorted ascending.
 * The fallbacks are not decoration: `n * 0.99` on a large group can floor to
 * `n` itself, and an empty group has no reading at all, which reads as 0.
 */
function percentile(ascendingValues: ArrayLike<number>, p: number): number {
  if (ascendingValues.length === 0) return 0;
  return ascendingValues[Math.floor(ascendingValues.length * p)]
    ?? ascendingValues[ascendingValues.length - 1]!;
}

/** Several lists' values in ascending order. As a typed array: a window's
 *  latencies run to hundreds of thousands, and sorting plain numbers through
 *  a comparator took several times as long as everything else done with them. */
function ascending(lists: ReadonlyArray<ArrayLike<number>>): Float64Array {
  const all = new Float64Array(lists.reduce((total, list) => total + list.length, 0));
  let at = 0;
  for (const list of lists) {
    all.set(list, at);
    at += list.length;
  }
  return all.sort();
}

/** Output tokens per second of each answered call's whole time, ascending. */
function speeds(outputs: ReadonlyArray<ArrayLike<number>>, latencies: ReadonlyArray<ArrayLike<number>>): Float64Array {
  const all = new Float64Array(outputs.reduce((total, list) => total + list.length, 0));
  let at = 0;
  for (let i = 0; i < outputs.length; i += 1) {
    const [output, latency] = [outputs[i]!, latencies[i]!];
    for (let j = 0; j < output.length; j += 1) all[at++] = (output[j]! / latency[j]!) * 1000;
  }
  return all.sort();
}

interface DayAccumulator {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencies: ArrayLike<number>[];
}

interface GroupAccumulator {
  key: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencies: ArrayLike<number>[];
  /** Only the calls that recorded one: most purposes do not stream. */
  ttfts: ArrayLike<number>[];
  rateOutputs: ArrayLike<number>[];
  rateLatencies: ArrayLike<number>[];
  reasons: Map<string, number>;
  spendMicros: number;
  spendEstimated: boolean;
  unpricedCalls: number;
}

/**
 * The figures of the parts' calls. Each part lies within `day`, one of the
 * reader's; several may share a day.
 */
export function finishFigures(
  parts: ReadonlyArray<{ day: string; figures: FiguresPart }>,
  input: {
    days: number;
    group: ActivityGroupKey;
    /** The reader's date now: the chart runs up to it. */
    today: string;
    /** The one day of the window the answer is for, when the reader picked one. */
    pickedDay: string | null;
  }
): Omit<ActivitySummaryResponse, "ledger"> {
  const { days, group } = input;
  const dayByDate = new Map<string, DayAccumulator>();
  const groupsByKey = new Map<string, GroupAccumulator>();
  const spend: ActivitySpendDto = { micros: 0, reportedMicros: 0, estimated: false, pricedCalls: 0, unpricedCalls: 0, includedCalls: 0, pendingCalls: 0 };
  // Grouped by day: each model's day, for the day charts.
  const trend = group === "day" ? new TrendAccumulator() : null;

  for (const { day: date, figures } of parts) {
    for (const tuple of figures.tuples) {
      let day = dayByDate.get(date);
      if (!day) {
        day = { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, latencies: [] };
        dayByDate.set(date, day);
      }
      day.calls += tuple.calls;
      day.failed += tuple.failed;
      day.inputTokens += tuple.inputTokens;
      day.outputTokens += tuple.outputTokens;
      day.cacheReadTokens += tuple.cacheReadTokens;
      day.latencies.push(tuple.latencies);

      const key = groupKeyOf(tuple, group, date);
      let groupEntry = groupsByKey.get(key);
      if (!groupEntry) {
        groupEntry = {
          key, calls: 0, failed: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          latencies: [], ttfts: [], rateOutputs: [], rateLatencies: [], reasons: new Map(),
          spendMicros: 0, spendEstimated: false, unpricedCalls: 0
        };
        groupsByKey.set(key, groupEntry);
      }
      groupEntry.calls += tuple.calls;
      groupEntry.failed += tuple.failed;
      groupEntry.inputTokens += tuple.inputTokens;
      groupEntry.outputTokens += tuple.outputTokens;
      groupEntry.cacheReadTokens += tuple.cacheReadTokens;
      groupEntry.latencies.push(tuple.latencies);
      groupEntry.ttfts.push(tuple.ttfts);
      groupEntry.rateOutputs.push(tuple.rateOutputs);
      groupEntry.rateLatencies.push(tuple.rateLatencies);
      groupEntry.spendMicros += tuple.spendMicros;
      if (tuple.estimated) groupEntry.spendEstimated = true;
      groupEntry.unpricedCalls += tuple.unpricedCalls;
      for (const [reason, calls] of tuple.reasons) groupEntry.reasons.set(reason, (groupEntry.reasons.get(reason) ?? 0) + calls);

      spend.micros += tuple.spendMicros;
      spend.reportedMicros += tuple.reportedMicros;
      if (tuple.estimated) spend.estimated = true;
      spend.pricedCalls += tuple.pricedCalls;
      spend.unpricedCalls += tuple.unpricedCalls;
      spend.includedCalls += tuple.includedCalls;
      spend.pendingCalls += tuple.pendingCalls;

      trend?.add(tuple, date);
    }
  }

  const daily: ActivityDailyDto[] = [...dayByDate.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([date, day]) => {
      const latencies = ascending(day.latencies);
      return {
        date,
        calls: day.calls,
        failed: day.failed,
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        cacheReadTokens: day.cacheReadTokens,
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95)
      };
    });
  // A window of N days touches at most N + 2 of the reader's dates: it opens
  // partway through the first, and a day the clocks spring forward is short.
  // A picked day's answer is that one day.
  const dates = input.pickedDay ? [input.pickedDay] : chartDates(daily.map((day) => day.date), input.today, days + 2);

  const groups: ActivityGroupDto[] = [...groupsByKey.values()]
    // Days read as a timeline, newest first; every other dimension reads as a
    // ranking. Ties break by name so two loads of the same window agree:
    // sqlite promises no order for the rows, and two groups on the same count
    // could otherwise swap places between loads.
    .sort((a, b) => (group === "day"
      ? compare(b.key, a.key)
      : b.calls - a.calls || compare(a.key, b.key)))
    .map((entry) => {
      const latencies = ascending(entry.latencies);
      const ttfts = ascending(entry.ttfts);
      const rates = speeds(entry.rateOutputs, entry.rateLatencies);
      return {
        key: entry.key,
        label: entry.key,
        calls: entry.calls,
        failed: entry.failed,
        p50Ms: percentile(latencies, 0.5),
        ttftP95Ms: ttfts.length > 0 ? percentile(ttfts, 0.95) : null,
        tokensPerSecondP50: rates.length > 0 ? Math.round(percentile(rates, 0.5) * 10) / 10 : null,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        reasons: [...entry.reasons]
          .map(([reason, calls]) => ({ reason, calls }))
          .sort((a, b) => b.calls - a.calls || compare(a.reason, b.reason)),
        spendMicros: entry.spendMicros,
        spendEstimated: entry.spendEstimated,
        unpricedCalls: entry.unpricedCalls
      };
    });

  return {
    days,
    spend,
    daily,
    dates,
    group,
    groups,
    ...(trend ? { trend: trend.build(dates) } : {})
  };
}

interface TrendCell {
  calls: number;
  failed: number;
  spendMicros: number;
  ttfts: ArrayLike<number>[];
}

/** Each model's calls, failures, spend and first tokens, day by day. */
class TrendAccumulator {
  private readonly calls = new Map<string, number>();
  private readonly cells = new Map<string, Map<string, TrendCell>>();

  add(tuple: FigureTuple, date: string): void {
    const model = groupKeyOf(tuple, "model", date);
    this.calls.set(model, (this.calls.get(model) ?? 0) + tuple.calls);
    let day = this.cells.get(date);
    if (!day) {
      day = new Map();
      this.cells.set(date, day);
    }
    let cell = day.get(model);
    if (!cell) {
      cell = { calls: 0, failed: 0, spendMicros: 0, ttfts: [] };
      day.set(model, cell);
    }
    cell.calls += tuple.calls;
    cell.failed += tuple.failed;
    // Spend as the totals count it: reported and estimated amounts.
    cell.spendMicros += tuple.spendMicros;
    cell.ttfts.push(tuple.ttfts);
  }

  /** The three busiest models (ties by name), then the rest as one line. */
  build(dates: string[]): ActivityTrendDto {
    const ranked = [...this.calls].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).map(([key]) => key);
    const top = ranked.slice(0, 3);
    const rest = ranked.slice(3);
    const series: ActivityTrendSeriesDto[] = [
      ...top.map((key) => ({ key, label: key, others: false, models: 1 })),
      ...(rest.length > 0 ? [{ key: "others", label: "others", others: true, models: rest.length }] : [])
    ];
    const restSet = new Set(rest);
    return {
      series,
      days: dates.map((date) => {
        const day = this.cells.get(date);
        const cellsOf = (key: string) => key === "others"
          ? [...(day?.entries() ?? [])].filter(([model]) => restSet.has(model)).map(([, cell]) => cell)
          : [day?.get(key)].filter((cell): cell is TrendCell => cell !== undefined);
        return {
          date,
          values: series.map(({ key }) => {
            const cells = cellsOf(key);
            const calls = cells.reduce((sum, cell) => sum + cell.calls, 0);
            const failed = cells.reduce((sum, cell) => sum + cell.failed, 0);
            const ttfts = ascending(cells.flatMap((cell) => cell.ttfts));
            return {
              key,
              calls,
              spendMicros: cells.reduce((sum, cell) => sum + cell.spendMicros, 0),
              ttftP95Ms: ttfts.length > 0 ? percentile(ttfts, 0.95) : null,
              failedRate: calls > 0 ? (failed / calls) * 100 : null
            };
          })
        };
      })
    };
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
