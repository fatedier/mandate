import type {
  ActivityAgentRowDto,
  ActivityCacheKind,
  ActivityCacheRowDto,
  ActivityLedgerDto,
  ActivityWakeRowDto,
  LedgerMoneyKind
} from "../../../shared/api/activity.js";
import type { ProviderConfig } from "../../config/types.js";
import { ratesForCall, storedScale, splitStoredAmount, type StoredCostRow } from "../pricing/call-rates.js";
import type { PriceCatalog } from "../pricing/catalog.js";
import { extraMicros, fixedCacheLifetimeMs, type CacheVerdict } from "./cache-verdicts.js";
import { agentRoleOf, wakeGroupOf } from "./ledger-roles.js";
import type { WindowCall } from "./window-calls.js";

/**
 * The Overview's ledger, worked out in parts that merge.
 *
 * A part is what a set of calls adds to the ledger: its sums, and beside
 * them what is not a sum (each expired call's idle time, the wakes its calls
 * belong to, each Claude model's first rates). Any number of parts, each
 * lying within one of the reader's days and handed over oldest first,
 * finish into the ledger the same calls would give read as one.
 */

export interface LedgerDeps {
  catalog: PriceCatalog | null;
  providers: Record<string, ProviderConfig>;
}

/** Sources whose amount is spend (as the figures count it). */
const SPEND_SOURCES = new Set(["reported", "your_price", "price_as", "list", "catalog"]);
const CACHE_ORDER: ActivityCacheKind[] = ["expired", "miss", "not_reused", "rebuild"];
/** Calls made outside any wake, each one judgement and its own row. */
const JUDGEMENT_PURPOSES = new Set(["manager_request_check", "manager_stop_check"]);
const HOUR = 60 * 60_000;

/** Calls, their spend and what the expired ones paid on top, with what their
 *  money reads as when none of it is spend. */
export interface LedgerBucket {
  calls: number;
  spend: number;
  expired: number;
  /** "spend" for any amount that is spend, else each cost source seen. */
  kinds: Set<string>;
}

export interface LedgerWakeBucket extends LedgerBucket {
  timer: boolean;
  runIds: Set<string>;
  /** Spend per role, in the order the roles were first seen. */
  roles: Map<string, number>;
}

export interface LedgerCacheBucket {
  calls: number;
  priced: number;
  rewritten: number;
  extra: number;
  families: Map<string, { extra: number; tokens: number }>;
}

/** The two rates the write/read ratio is read from. */
export interface LedgerRatioRates {
  cacheWrite?: number;
  cacheRead?: number;
}

export interface LedgerPart {
  /** Spend, the expired calls' extra, and how many calls are spend. */
  spend: number;
  expired: number;
  spendCalls: number;
  /** By role, in the order first seen. */
  agents: Map<string, LedgerBucket>;
  cache: Map<ActivityCacheKind, LedgerCacheBucket>;
  /** Each expired call's idle time. */
  expiredIdles: number[];
  tokens: { uncachedInputMicros: number; cacheReadMicros: number; cacheWriteMicros: number; outputMicros: number; reportedUnsplitMicros: number };
  /** By wake group, in the order first seen. */
  wakes: Map<string, LedgerWakeBucket>;
  /** Each model on the Anthropic protocol, in the order first seen: its
   *  spend, and the rates of its first call that has rates. */
  claude: Map<string, { spend: number; rates: LedgerRatioRates | null }>;
  wrote1h: boolean;
  priceDataDate: string | null;
}

const bucket = (): LedgerBucket => ({ calls: 0, spend: 0, expired: 0, kinds: new Set() });

export function newLedgerPart(): LedgerPart {
  return {
    spend: 0, expired: 0, spendCalls: 0,
    agents: new Map(), cache: new Map(), expiredIdles: [],
    tokens: { uncachedInputMicros: 0, cacheReadMicros: 0, cacheWriteMicros: 0, outputMicros: 0, reportedUnsplitMicros: 0 },
    wakes: new Map(), claude: new Map(), wrote1h: false, priceDataDate: null
  };
}

/** Parsed once per distinct text: a window holds thousands of calls and a
 *  handful of price refs. */
const dataDates = new Map<string, string | null>();

function dataDateOf(ref: string | null): string | null {
  if (!ref) return null;
  if (dataDates.has(ref)) return dataDates.get(ref)!;
  let date: string | null = null;
  try {
    const value: unknown = JSON.parse(ref);
    date = value && typeof value === "object" && typeof (value as { dataDate?: unknown }).dataDate === "string" ? (value as { dataDate: string }).dataDate : null;
  } catch {
    date = null;
  }
  if (dataDates.size > 1000) dataDates.clear();
  dataDates.set(ref, date);
  return date;
}

function storedCost(r: WindowCall): StoredCostRow {
  return {
    providerName: r.provider_name, provider: r.provider, baseURL: r.base_url, model: r.model,
    costSource: r.cost_source, costRef: r.cost_ref, costMicros: r.cost_micros,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens, cacheWrite1hTokens: r.cache_write_1h_tokens, serviceTier: r.service_tier
  };
}

/** The model family a `not_reused` row names: the id after its last `/`, cut
 *  before its first `-` (`openai/gpt-6.1-sol` → `gpt`). */
function familyOf(model: string | null): string | null {
  if (!model) return null;
  const name = model.slice(model.lastIndexOf("/") + 1);
  const family = name.split("-")[0]?.trim();
  return family ? family.toLowerCase() : null;
}

const kindOf = (source: string) => (SPEND_SOURCES.has(source) ? "spend" : source);

function bump(map: Map<string, LedgerBucket>, key: string): LedgerBucket {
  let b = map.get(key);
  if (!b) {
    b = bucket();
    map.set(key, b);
  }
  return b;
}

/** Adds one call, with the verdict it was judged (none for a call that is
 *  not a judged step). */
export function addLedgerCall(part: LedgerPart, r: WindowCall, verdict: CacheVerdict | undefined, deps: LedgerDeps): void {
  const isSpend = r.cost_source !== null && SPEND_SOURCES.has(r.cost_source);
  const micros = isSpend ? r.cost_micros ?? 0 : 0;
  const stored = isSpend ? storedCost(r) : null;
  // A reported amount too: shared out by the rates its call would have had.
  const rates = stored ? ratesForCall(stored, deps.catalog, deps.providers) : null;
  const scale = rates && stored ? storedScale(stored, rates) : null;
  if ((r.cache_write_1h_tokens ?? 0) > 0) part.wrote1h = true;
  if (isSpend) {
    part.spendCalls += 1;
    const date = dataDateOf(r.cost_ref);
    if (date && (part.priceDataDate === null || date > part.priceDataDate)) part.priceDataDate = date;
  }

  const extra = verdict && rates && scale !== null ? Math.round(extraMicros(verdict, rates) * scale) : 0;
  const expired = verdict?.kind === "expired" ? extra : 0;

  part.spend += micros;
  part.expired += expired;

  const role = agentRoleOf(r.purpose, r.recorded_scope);
  const a = bump(part.agents, role);
  a.calls += 1;
  a.spend += micros;
  a.expired += expired;
  if (r.cost_source) a.kinds.add(kindOf(r.cost_source));

  if (verdict) {
    let c = part.cache.get(verdict.kind);
    if (!c) {
      c = { calls: 0, priced: 0, rewritten: 0, extra: 0, families: new Map() };
      part.cache.set(verdict.kind, c);
    }
    c.calls += 1;
    if (rates && scale !== null) c.priced += 1;
    c.rewritten += verdict.shortfallTokens;
    c.extra += extra;
    const family = familyOf(r.model);
    if (family) {
      const f = c.families.get(family) ?? { extra: 0, tokens: 0 };
      c.families.set(family, { extra: f.extra + extra, tokens: f.tokens + verdict.shortfallTokens });
    }
    if (verdict.kind === "expired") part.expiredIdles.push(verdict.idleMs);
  }

  if (isSpend) {
    const split = rates && stored ? splitStoredAmount(stored, rates) : null;
    if (split) {
      part.tokens.uncachedInputMicros += split.uncachedInput;
      part.tokens.cacheReadMicros += split.cacheRead;
      part.tokens.cacheWriteMicros += split.cacheWrite;
      part.tokens.outputMicros += split.output;
    } else if (r.cost_source === "reported") {
      part.tokens.reportedUnsplitMicros += micros;
    }
    // Every amount ranks the model, reported ones too; the rates come from
    // whichever of its calls has them.
    if (r.model && fixedCacheLifetimeMs(r.provider, false) !== null) {
      let entry = part.claude.get(r.model);
      if (!entry) {
        entry = { spend: 0, rates: null };
        part.claude.set(r.model, entry);
      }
      entry.spend += micros;
      if (entry.rates === null && rates) {
        entry.rates = {
          ...(rates.cacheWrite !== undefined ? { cacheWrite: rates.cacheWrite } : {}),
          ...(rates.cacheRead !== undefined ? { cacheRead: rates.cacheRead } : {})
        };
      }
    }
  }

  // What woke it: a wake's group by the reason the call recorded (its
  // wake's row goes with its thread, and the figures must not move then),
  // the dream, or a judgement (the request check, the manager stop check),
  // each its own.
  const groupKey = r.wake_id
    ? wakeGroupOf(r.recorded_wake_reason)
    : r.purpose === "memory_dream" ? { key: "dream", timer: true }
      : JUDGEMENT_PURPOSES.has(r.purpose) ? { key: r.purpose, timer: false } : null;
  if (groupKey) {
    let w = part.wakes.get(groupKey.key);
    if (!w) {
      w = { ...bucket(), timer: groupKey.timer, runIds: new Set(), roles: new Map() };
      part.wakes.set(groupKey.key, w);
    }
    w.calls += 1;
    w.spend += micros;
    w.expired += expired;
    if (r.cost_source) w.kinds.add(kindOf(r.cost_source));
    if (r.wake_id) w.runIds.add(r.wake_id);
    w.roles.set(role, (w.roles.get(role) ?? 0) + micros);
  }
}

/** What a row of money reads as when none of its calls cost anything. */
function moneyKind(kinds: ReadonlySet<string>): LedgerMoneyKind {
  for (const kind of ["spend", "included", "free", "unpriced"] as const) if (kinds.has(kind)) return kind;
  return "none";
}

function addBucket(into: LedgerBucket, from: LedgerBucket): void {
  into.calls += from.calls;
  into.spend += from.spend;
  into.expired += from.expired;
  for (const kind of from.kinds) into.kinds.add(kind);
}

/**
 * The ledger of the parts' calls. Each part lies within `day`, one of the
 * reader's; several may share a day. Oldest first: where two Claude models
 * spent the same, the one seen first names the write/read ratio, and a
 * model's rates are its first call's that has them.
 */
export function finishLedger(
  parts: ReadonlyArray<{ day: string; ledger: LedgerPart }>,
  extra: {
    /** Dream runs started in the window: they are counted from their own table. */
    dreamRuns: number;
    /** The spend of the period before, and how many calls it is. */
    previous: { micros: number; calls: number };
  }
): ActivityLedgerDto {
  const dayMap = new Map<string, { spend: number; expired: number }>();
  const total = newLedgerPart();
  for (const { day, ledger: part } of parts) {
    const d = dayMap.get(day) ?? { spend: 0, expired: 0 };
    d.spend += part.spend;
    d.expired += part.expired;
    // A part with no call makes no day.
    if (part.agents.size > 0) dayMap.set(day, d);

    for (const [role, b] of part.agents) addBucket(bump(total.agents, role), b);
    for (const [kind, c] of part.cache) {
      let into = total.cache.get(kind);
      if (!into) {
        into = { calls: 0, priced: 0, rewritten: 0, extra: 0, families: new Map() };
        total.cache.set(kind, into);
      }
      into.calls += c.calls;
      into.priced += c.priced;
      into.rewritten += c.rewritten;
      into.extra += c.extra;
      for (const [family, f] of c.families) {
        const sum = into.families.get(family) ?? { extra: 0, tokens: 0 };
        into.families.set(family, { extra: sum.extra + f.extra, tokens: sum.tokens + f.tokens });
      }
    }
    for (const idle of part.expiredIdles) total.expiredIdles.push(idle);
    total.tokens.uncachedInputMicros += part.tokens.uncachedInputMicros;
    total.tokens.cacheReadMicros += part.tokens.cacheReadMicros;
    total.tokens.cacheWriteMicros += part.tokens.cacheWriteMicros;
    total.tokens.outputMicros += part.tokens.outputMicros;
    total.tokens.reportedUnsplitMicros += part.tokens.reportedUnsplitMicros;
    for (const [key, w] of part.wakes) {
      let into = total.wakes.get(key);
      if (!into) {
        into = { ...bucket(), timer: w.timer, runIds: new Set(), roles: new Map() };
        total.wakes.set(key, into);
      }
      addBucket(into, w);
      for (const id of w.runIds) into.runIds.add(id);
      for (const [role, micros] of w.roles) into.roles.set(role, (into.roles.get(role) ?? 0) + micros);
    }
    for (const [model, c] of part.claude) {
      let into = total.claude.get(model);
      if (!into) {
        into = { spend: 0, rates: null };
        total.claude.set(model, into);
      }
      into.spend += c.spend;
      into.rates ??= c.rates;
    }
    if (part.wrote1h) total.wrote1h = true;
    if (part.priceDataDate && (total.priceDataDate === null || part.priceDataDate > total.priceDataDate)) total.priceDataDate = part.priceDataDate;
  }

  const { dreamRuns, previous } = extra;
  // Dream runs that left no calls (a run that failed before its first) still ran.
  if (dreamRuns > 0 && !total.wakes.has("dream")) total.wakes.set("dream", { ...bucket(), timer: true, runIds: new Set(), roles: new Map([["dream", 0]]) });

  const agentRows: ActivityAgentRowDto[] = [...total.agents]
    .map(([role, b]) => ({ role, calls: b.calls, spendMicros: b.spend, expiredExtraMicros: b.expired, money: moneyKind(b.kinds) }))
    .sort((x, y) => y.spendMicros - x.spendMicros || y.calls - x.calls || compare(x.role, y.role));

  const cacheRows: ActivityCacheRowDto[] = CACHE_ORDER.flatMap((kind) => {
    const c = total.cache.get(kind);
    if (!c || c.calls === 0) return [];
    // By what it cost on top; without rates (all zero), by the tokens rewritten.
    const top = kind === "not_reused"
      ? [...c.families].sort((x, y) => y[1].extra - x[1].extra || y[1].tokens - x[1].tokens || compare(x[0], y[0]))[0]?.[0] ?? null
      : null;
    return [{ kind, calls: c.calls, pricedCalls: c.priced, rewrittenTokens: c.rewritten, extraMicros: c.extra, topFamily: top }];
  });

  const wakeRows: ActivityWakeRowDto[] = [...total.wakes].map(([key, w]) => ({
    key,
    timer: w.timer,
    runs: key === "dream" ? dreamRuns : JUDGEMENT_PURPOSES.has(key) ? w.calls : w.runIds.size,
    spendMicros: w.spend,
    expiredExtraMicros: w.expired,
    roles: [...w.roles].sort((x, y) => y[1] - x[1] || compare(x[0], y[0])).map(([role]) => role),
    money: moneyKind(w.kinds)
  })).sort((x, y) => y.spendMicros - x.spendMicros || y.runs - x.runs || compare(x.key, y.key));

  const expiredIdles = total.expiredIdles.sort((x, y) => x - y);
  const topClaude = [...total.claude.values()].sort((x, y) => y.spend - x.spend)[0];
  const ratio = topClaude?.rates && topClaude.rates.cacheWrite !== undefined && topClaude.rates.cacheRead
    ? Math.round((topClaude.rates.cacheWrite / topClaude.rates.cacheRead) * 10) / 10
    : null;

  return {
    previousSpendMicros: previous.calls > 0 ? previous.micros : null,
    days: [...dayMap].sort(([x], [y]) => compare(x, y)).map(([date, d]) => ({ date, spendMicros: d.spend, expiredExtraMicros: d.expired })),
    agents: agentRows,
    cache: {
      rows: cacheRows,
      expiredWithinHour: expiredIdles.filter((idle) => idle <= HOUR).length,
      medianExpiredIdleMs: median(expiredIdles),
      wrote1h: total.wrote1h
    },
    tokens: total.tokens,
    wakes: wakeRows,
    priceDataDate: total.priceDataDate,
    claudeWriteReadRatio: ratio !== null && Number.isFinite(ratio) ? ratio : null
  };
}

/** The middle of an ascending list; the mean of the middle two when even. */
function median(ascending: number[]): number | null {
  const n = ascending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? ascending[mid]! : Math.round((ascending[mid - 1]! + ascending[mid]!) / 2);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
