import type { Database } from "bun:sqlite";
import type { ActivityCacheKind } from "../../../shared/api/activity.js";
import type { ActivityPart } from "./activity-parts.js";
import type { FigureTuple } from "./figures-part.js";
import type { LedgerBucket, LedgerPart, LedgerRatioRates } from "./ledger-part.js";

/**
 * A slice's facts as a row of `activity_slices`, and the keeping of rows.
 *
 * `facts` is JSON: the tuples' sums and reasons, and the ledger's part.
 * `vals` holds what the percentiles are read from, every tuple's latencies,
 * first-token times and output/latency pairs, one after the other as 64-bit
 * floats: any stored number comes back as it was, whole or not, however large.
 */

/** Raised whenever the kept facts, or what they mean, change: rows kept
 *  under another layout are worked out again. */
export const SLICE_LAYOUT = 1;

/** How far back slices are kept: a 30-day window and the 30 days it is
 *  compared with, and a little over. */
export const SLICES_KEPT_DAYS = 62;

export interface SliceRow {
  start: string;
  builtSeq: number;
  inputs: string;
  spendMicros: number;
  spendCalls: number;
  facts: string;
  vals: Uint8Array;
}

type TupleFacts = [
  purpose: string, providerName: string | null, model: string, scopeType: string, fallback: 0 | 1,
  calls: number, failed: number, inputTokens: number, outputTokens: number, cacheReadTokens: number,
  spendMicros: number, reportedMicros: number, estimated: 0 | 1,
  pricedCalls: number, unpricedCalls: number, includedCalls: number, pendingCalls: number,
  latencies: number, ttfts: number, rates: number,
  reasons: Array<[string, number]>
];
type BucketFacts = [calls: number, spend: number, expired: number, kinds: string[]];

interface Facts {
  tuples: TupleFacts[];
  ledger: {
    spend: number;
    expired: number;
    spendCalls: number;
    agents: Array<[role: string, ...BucketFacts]>;
    cache: Array<[kind: ActivityCacheKind, calls: number, priced: number, rewritten: number, extra: number, families: Array<[string, number, number]>]>;
    expiredIdles: number[];
    tokens: LedgerPart["tokens"];
    wakes: Array<[key: string, timer: 0 | 1, ...BucketFacts, runIds: string[], roles: Array<[string, number]>]>;
    claude: Array<[model: string, spend: number, rates: LedgerRatioRates | null]>;
    wrote1h: 0 | 1;
    priceDataDate: string | null;
  };
}

const bucketFacts = (b: LedgerBucket): BucketFacts => [b.calls, b.spend, b.expired, [...b.kinds]];
const bucketOf = (calls: number, spend: number, expired: number, kinds: string[]): LedgerBucket => ({ calls, spend, expired, kinds: new Set(kinds) });

export function encodeSlice(start: string, part: ActivityPart, builtSeq: number, inputs: string): SliceRow {
  const { figures, ledger } = part;
  const values = new Float64Array(figures.tuples.reduce((n, t) => n + t.latencies.length + t.ttfts.length + 2 * t.rateOutputs.length, 0));
  let at = 0;
  for (const t of figures.tuples) {
    for (const list of [t.latencies, t.ttfts, t.rateOutputs, t.rateLatencies]) {
      values.set(list, at);
      at += list.length;
    }
  }
  const facts: Facts = {
    tuples: figures.tuples.map((t) => [
      t.purpose, t.provider_name, t.model, t.scope_type, t.fallback ? 1 : 0,
      t.calls, t.failed, t.inputTokens, t.outputTokens, t.cacheReadTokens,
      t.spendMicros, t.reportedMicros, t.estimated ? 1 : 0,
      t.pricedCalls, t.unpricedCalls, t.includedCalls, t.pendingCalls,
      t.latencies.length, t.ttfts.length, t.rateOutputs.length,
      [...t.reasons]
    ]),
    ledger: {
      spend: ledger.spend, expired: ledger.expired, spendCalls: ledger.spendCalls,
      agents: [...ledger.agents].map(([role, b]) => [role, ...bucketFacts(b)]),
      cache: [...ledger.cache].map(([kind, c]) => [kind, c.calls, c.priced, c.rewritten, c.extra, [...c.families].map(([family, f]) => [family, f.extra, f.tokens])]),
      expiredIdles: ledger.expiredIdles,
      tokens: ledger.tokens,
      wakes: [...ledger.wakes].map(([key, w]) => [key, w.timer ? 1 : 0, ...bucketFacts(w), [...w.runIds], [...w.roles]]),
      claude: [...ledger.claude].map(([model, c]) => [model, c.spend, c.rates]),
      wrote1h: ledger.wrote1h ? 1 : 0,
      priceDataDate: ledger.priceDataDate
    }
  };
  return {
    start, builtSeq, inputs,
    spendMicros: ledger.spend, spendCalls: ledger.spendCalls,
    facts: JSON.stringify(facts),
    vals: new Uint8Array(values.buffer)
  };
}

export function decodeSlice(row: Pick<SliceRow, "facts" | "vals">): ActivityPart {
  const facts = JSON.parse(row.facts) as Facts;
  // A view needs its bytes on an 8-byte boundary; bytes that are not are copied.
  const bytes = row.vals.byteOffset % 8 === 0 ? row.vals : row.vals.slice();
  const values = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
  let at = 0;
  const take = (count: number): Float64Array => {
    const list = values.subarray(at, at + count);
    at += count;
    return list;
  };
  const tuples = facts.tuples.map((t): FigureTuple => ({
    purpose: t[0], provider_name: t[1], model: t[2], scope_type: t[3], fallback: t[4] === 1,
    calls: t[5], failed: t[6], inputTokens: t[7], outputTokens: t[8], cacheReadTokens: t[9],
    spendMicros: t[10], reportedMicros: t[11], estimated: t[12] === 1,
    pricedCalls: t[13], unpricedCalls: t[14], includedCalls: t[15], pendingCalls: t[16],
    latencies: take(t[17]), ttfts: take(t[18]), rateOutputs: take(t[19]), rateLatencies: take(t[19]),
    reasons: new Map(t[20])
  }));
  const l = facts.ledger;
  const ledger: LedgerPart = {
    spend: l.spend, expired: l.expired, spendCalls: l.spendCalls,
    agents: new Map(l.agents.map(([role, calls, spend, expired, kinds]) => [role, bucketOf(calls, spend, expired, kinds)])),
    cache: new Map(l.cache.map(([kind, calls, priced, rewritten, extra, families]) =>
      [kind, { calls, priced, rewritten, extra, families: new Map(families.map(([family, familyExtra, tokens]) => [family, { extra: familyExtra, tokens }])) }])),
    expiredIdles: l.expiredIdles,
    tokens: l.tokens,
    wakes: new Map(l.wakes.map(([key, timer, calls, spend, expired, kinds, runIds, roles]) =>
      [key, { ...bucketOf(calls, spend, expired, kinds), timer: timer === 1, runIds: new Set(runIds), roles: new Map(roles) }])),
    claude: new Map(l.claude.map(([model, spend, rates]) => [model, { spend, rates }])),
    wrote1h: l.wrote1h === 1,
    priceDataDate: l.priceDataDate
  };
  return { figures: { tuples }, ledger };
}

/**
 * Keeps rows, on the server's own connection (the only writer). A row is
 * kept unless one built from a later snapshot is there already: two answers
 * can be under way at once, and the older build must not replace the newer.
 *
 * Slices before `horizon` go, with the changes recorded for them: the newest
 * of those changes becomes the floor, below which nothing built is trusted
 * (a change reaches every slice after it, whether or not it is still listed).
 *
 * At most `limit` rows a call, in one short transaction; the rest come back
 * for the next.
 */
export function keepSlices(db: Database, rows: readonly SliceRow[], horizon: string, limit = rows.length): SliceRow[] {
  const now = rows.slice(0, limit);
  const upsert = db.prepare(`
    insert into activity_slices (start, built_seq, inputs, spend_micros, spend_calls, facts, vals) values (?, ?, ?, ?, ?, ?, ?)
    on conflict(start) do update set
      built_seq = excluded.built_seq, inputs = excluded.inputs, spend_micros = excluded.spend_micros, spend_calls = excluded.spend_calls,
      facts = excluded.facts, vals = excluded.vals
    where excluded.built_seq >= activity_slices.built_seq
  `);
  db.transaction(() => {
    for (const row of now) upsert.run(row.start, row.builtSeq, row.inputs, row.spendMicros, row.spendCalls, row.facts, row.vals);
    // A row before the horizon, just kept or long there, goes here.
    db.prepare("delete from activity_slices where start < ?").run(horizon);
    db.prepare("update activity_rollup_state set floor = max(floor, coalesce((select max(seq) from activity_slice_changes where start < ?), 0)) where id = 1").run(horizon);
    db.prepare("delete from activity_slice_changes where start < ?").run(horizon);
  })();
  return rows.slice(limit);
}
