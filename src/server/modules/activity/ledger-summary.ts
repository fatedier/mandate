import type { Database } from "bun:sqlite";
import type {
  ActivityAgentRowDto,
  ActivityCacheKind,
  ActivityCacheRowDto,
  ActivityLedgerDto,
  ActivityWakeRowDto,
  LedgerMoneyKind
} from "../../../shared/api/activity.js";
import type { ProviderConfig } from "../../config/types.js";
import { ratesForStoredCall, splitStoredAmount, type StoredCostRow } from "../pricing/call-rates.js";
import type { PriceCatalog } from "../pricing/catalog.js";
import type { RateSet } from "../pricing/rates.js";
import { extraMicros, fixedCacheLifetimeMs, type CacheVerdict } from "./cache-verdicts.js";
import { agentRoleOf, wakeGroupOf } from "./ledger-roles.js";
import { activityRange, END_OF_TIME, type ActivityRange } from "./local-days.js";
import { threadStepFromRow, verdictsForSteps, type ThreadStep } from "./window-verdicts.js";

export interface LedgerDeps {
  catalog: PriceCatalog | null;
  providers: Record<string, ProviderConfig>;
}

/** Sources whose amount is spend (as the summary counts it). */
const SPEND_SOURCES = new Set(["reported", "your_price", "price_as", "list", "catalog"]);
const CACHE_ORDER: ActivityCacheKind[] = ["expired", "miss", "not_reused", "rebuild"];
/** Calls made outside any wake, each one judgement and its own row. */
const JUDGEMENT_PURPOSES = new Set(["manager_request_check", "manager_stop_check"]);
const HOUR = 60 * 60_000;

interface LedgerRow {
  id: string;
  purpose: string;
  scope_type: string | null;
  scope_id: string | null;
  provider: string;
  provider_name: string | null;
  base_url: string | null;
  model: string | null;
  connection: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  input_tokens: number | null;
  context_tokens: number | null;
  cache_ttl: string | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_1h_tokens: number | null;
  cache_write_5m_tokens: number | null;
  api_type: string | null;
  service_tier: string | null;
  cost_source: string | null;
  cost_micros: number | null;
  cost_ref: string | null;
  thread_scope: string | null;
  thread_known: number | null;
  /** `[threadScope, wakeId, wakeReason]` from the metadata, as
   *  one JSON array: one read of the column instead of four. */
  meta: string | null;
  recorded_scope: string | null;
  wake_id: string | null;
  recorded_wake_reason: string | null;
}

/** One guarded read of the metadata keys the ledger needs (json_extract
 *  raises on malformed text, and with several paths answers a JSON array). */
const META_SQL = "case when json_valid(l.metadata_json) then json_extract(l.metadata_json, '$.threadScope', '$.wakeId', '$.wakeReason') end";

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function readMeta(r: LedgerRow): void {
  let values: unknown = null;
  try {
    values = r.meta ? JSON.parse(r.meta) : null;
  } catch {
    values = null;
  }
  const [threadScope, wakeId, wakeReason] = Array.isArray(values) ? values : [];
  r.recorded_scope = text(threadScope);
  r.wake_id = text(wakeId);
  r.recorded_wake_reason = text(wakeReason);
}

/** Parsed once per distinct text: a window holds thousands of calls and a
 *  handful of price refs. */
const dataDates = new Map<string, string | null>();

function storedCost(r: LedgerRow): StoredCostRow {
  return {
    providerName: r.provider_name, provider: r.provider, baseURL: r.base_url, model: r.model,
    costSource: r.cost_source, costRef: r.cost_ref, costMicros: r.cost_micros,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens, cacheWrite1hTokens: r.cache_write_1h_tokens, serviceTier: r.service_tier
  };
}

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

/** The model family a `not_reused` row names: the id after its last `/`, cut
 *  before its first `-` (`openai/gpt-6.1-sol` → `gpt`). */
function familyOf(model: string | null): string | null {
  if (!model) return null;
  const name = model.slice(model.lastIndexOf("/") + 1);
  const family = name.split("-")[0]?.trim();
  return family ? family.toLowerCase() : null;
}

/** What a row of money reads as when none of its calls cost anything. */
class MoneyKinds {
  private readonly seen = new Set<string>();
  add(source: string | null): void {
    if (source) this.seen.add(SPEND_SOURCES.has(source) ? "spend" : source);
  }
  kind(): LedgerMoneyKind {
    for (const kind of ["spend", "included", "free", "unpriced"] as const) if (this.seen.has(kind)) return kind;
    return "none";
  }
}

interface Bucket {
  calls: number;
  spend: number;
  expired: number;
  money: MoneyKinds;
}
const bucket = (): Bucket => ({ calls: 0, spend: 0, expired: 0, money: new MoneyKinds() });

function bump<K>(map: Map<K, Bucket>, key: K): Bucket {
  let b = map.get(key);
  if (!b) {
    b = bucket();
    map.set(key, b);
  }
  return b;
}

/**
 * The Overview's ledger for the last `days` days: spend per day and the part
 * the cache-expired calls paid on top; who spent it; the cache verdicts; what
 * the spend is made of; and what woke the agents. Worked out from the stored
 * calls when the page reads — nothing here is stored.
 */
export function buildActivityLedger(
  db: Database,
  days: number,
  deps: LedgerDeps,
  now = Date.now(),
  range: ActivityRange = activityRange({ days, now })
): ActivityLedgerDto {
  const { since, clock } = range;
  const until = range.until ?? END_OF_TIME;

  const rows = db.prepare(`
    select l.id, l.purpose, l.scope_type, l.scope_id, l.provider, l.provider_name, l.base_url, l.model,
           coalesce(l.provider_name, l.provider) connection, l.status, l.started_at, l.finished_at, l.created_at,
           l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_write_tokens, l.cache_write_1h_tokens, l.cache_write_5m_tokens,
           (case when json_valid(l.metadata_json) then json_extract(l.metadata_json, '$.contextInputTokens') end) context_tokens,
           (case when json_valid(l.metadata_json) then json_extract(l.metadata_json, '$.cacheTtl') end) cache_ttl,
           l.provider api_type, l.service_tier,
           l.cost_source, l.cost_micros, l.cost_ref,
           t.scope thread_scope, case when t.id is null then null else 1 end thread_known,
           ${META_SQL} meta
    from llm_calls l
    left join agent_threads t on t.id = l.scope_id and l.scope_type = 'agent_thread'
    where l.created_at > ? and l.created_at < ?
  `).all(since, until) as LedgerRow[];
  for (const r of rows) readMeta(r);

  // Verdicts, judged as the Logs rows judge them.
  const steps: ThreadStep[] = [];
  for (const r of rows) {
    if (r.scope_type === "agent_thread" && r.scope_id && (r.purpose === "agent_wake_step" || r.purpose === "agent_compression" || r.purpose === "agent_cache_seal")) {
      steps.push(threadStepFromRow({ ...r, scope_id: r.scope_id }));
    }
  }
  const verdicts = verdictsForSteps(db, steps, since);

  // Wake reasons: the wake's row, else what the call recorded.
  const wakeIds = [...new Set(rows.map((r) => r.wake_id).filter((id): id is string => id !== null))];
  const wakeReasons = new Map<string, string>();
  if (wakeIds.length) {
    const found = db.prepare("select id, reason from agent_wakes where id in (select value from json_each(?))").all(JSON.stringify(wakeIds)) as Array<{ id: string; reason: string }>;
    for (const w of found) wakeReasons.set(w.id, w.reason);
  }

  const dayMap = new Map<string, { spend: number; expired: number }>();
  const agents = new Map<string, Bucket>();
  const cache = new Map<ActivityCacheKind, { calls: number; priced: number; rewritten: number; extra: number; families: Map<string, { extra: number; tokens: number }> }>();
  const expiredIdles: number[] = [];
  const tokens = { uncachedInputMicros: 0, cacheReadMicros: 0, cacheWriteMicros: 0, outputMicros: 0, reportedUnsplitMicros: 0 };
  const wakes = new Map<string, Bucket & { timer: boolean; runIds: Set<string>; roles: Map<string, number> }>();
  const claudeSpend = new Map<string, { spend: number; rates: RateSet | null }>();
  let wrote1h = false;
  let priceDataDate: string | null = null;

  for (const r of rows) {
    const isSpend = r.cost_source !== null && SPEND_SOURCES.has(r.cost_source);
    const micros = isSpend ? r.cost_micros ?? 0 : 0;
    const needsRates = isSpend && r.cost_source !== "reported";
    const stored = isSpend ? storedCost(r) : null;
    const rates = needsRates && stored ? ratesForStoredCall(stored, deps.catalog, deps.providers) : null;
    if ((r.cache_write_1h_tokens ?? 0) > 0) wrote1h = true;
    if (isSpend) {
      const date = dataDateOf(r.cost_ref);
      if (date && (priceDataDate === null || date > priceDataDate)) priceDataDate = date;
    }

    const verdict: CacheVerdict | undefined = verdicts.get(r.id);
    const extra = verdict && rates ? extraMicros(verdict, rates) : 0;
    const expired = verdict?.kind === "expired" ? extra : 0;

    const day = clock.dayOf(r.created_at);
    const d = dayMap.get(day) ?? { spend: 0, expired: 0 };
    d.spend += micros;
    d.expired += expired;
    dayMap.set(day, d);

    const threadScope = r.thread_scope ?? r.recorded_scope;
    const role = agentRoleOf(r.purpose, threadScope, r.thread_known === 1);
    const a = bump(agents, role);
    a.calls += 1;
    a.spend += micros;
    a.expired += expired;
    a.money.add(r.cost_source);

    if (verdict) {
      const c = cache.get(verdict.kind) ?? { calls: 0, priced: 0, rewritten: 0, extra: 0, families: new Map<string, { extra: number; tokens: number }>() };
      c.calls += 1;
      if (rates) c.priced += 1;
      c.rewritten += verdict.shortfallTokens;
      c.extra += extra;
      const family = familyOf(r.model);
      if (family) {
        const f = c.families.get(family) ?? { extra: 0, tokens: 0 };
        c.families.set(family, { extra: f.extra + extra, tokens: f.tokens + verdict.shortfallTokens });
      }
      cache.set(verdict.kind, c);
      if (verdict.kind === "expired") expiredIdles.push(verdict.idleMs);
    }

    if (isSpend) {
      const split = rates && stored ? splitStoredAmount(stored, rates) : null;
      if (split) {
        tokens.uncachedInputMicros += split.uncachedInput;
        tokens.cacheReadMicros += split.cacheRead;
        tokens.cacheWriteMicros += split.cacheWrite;
        tokens.outputMicros += split.output;
      } else if (r.cost_source === "reported") {
        tokens.reportedUnsplitMicros += micros;
      }
      // Every amount ranks the model, reported ones too; the rates come from
      // whichever of its calls has them.
      if (r.model && fixedCacheLifetimeMs(r.provider, false) !== null) {
        const entry = claudeSpend.get(r.model) ?? { spend: 0, rates: null };
        entry.spend += micros;
        entry.rates ??= rates;
        claudeSpend.set(r.model, entry);
      }
    }

    // What woke it: a wake's group, the dream, or a judgement (the request
    // check, the manager stop check), each its own.
    const groupKey = r.wake_id
      ? wakeGroupOf(wakeReasons.get(r.wake_id) ?? r.recorded_wake_reason)
      : r.purpose === "memory_dream" ? { key: "dream", timer: true }
        : JUDGEMENT_PURPOSES.has(r.purpose) ? { key: r.purpose, timer: false } : null;
    if (groupKey) {
      let w = wakes.get(groupKey.key);
      if (!w) {
        w = { ...bucket(), timer: groupKey.timer, runIds: new Set(), roles: new Map() };
        wakes.set(groupKey.key, w);
      }
      w.calls += 1;
      w.spend += micros;
      w.expired += expired;
      w.money.add(r.cost_source);
      if (r.wake_id) w.runIds.add(r.wake_id);
      w.roles.set(role, (w.roles.get(role) ?? 0) + micros);
    }
  }

  const dreamRuns = (db.prepare("select count(*) n from memory_dream_runs where started_at > ? and started_at < ?").get(since, until) as { n: number }).n;
  // Dream runs that left no calls (a run that failed before its first) still ran.
  if (dreamRuns > 0 && !wakes.has("dream")) wakes.set("dream", { ...bucket(), timer: true, runIds: new Set(), roles: new Map([["dream", 0]]) });
  const previous = db.prepare(`select coalesce(sum(cost_micros), 0) s, count(*) n from llm_calls
    where created_at > ? and created_at <= ? and cost_source in ('reported', 'your_price', 'price_as', 'list', 'catalog')`).get(range.previousSince, range.previousUntil) as { s: number; n: number };

  const agentRows: ActivityAgentRowDto[] = [...agents]
    .map(([role, b]) => ({ role, calls: b.calls, spendMicros: b.spend, expiredExtraMicros: b.expired, money: b.money.kind() }))
    .sort((x, y) => y.spendMicros - x.spendMicros || y.calls - x.calls || compare(x.role, y.role));

  const cacheRows: ActivityCacheRowDto[] = CACHE_ORDER.flatMap((kind) => {
    const c = cache.get(kind);
    if (!c || c.calls === 0) return [];
    // By what it cost on top; without rates (all zero), by the tokens rewritten.
    const top = kind === "not_reused"
      ? [...c.families].sort((x, y) => y[1].extra - x[1].extra || y[1].tokens - x[1].tokens || compare(x[0], y[0]))[0]?.[0] ?? null
      : null;
    return [{ kind, calls: c.calls, pricedCalls: c.priced, rewrittenTokens: c.rewritten, extraMicros: c.extra, topFamily: top }];
  });

  const wakeRows: ActivityWakeRowDto[] = [...wakes].map(([key, w]) => ({
    key,
    timer: w.timer,
    runs: key === "dream" ? dreamRuns : JUDGEMENT_PURPOSES.has(key) ? w.calls : w.runIds.size,
    spendMicros: w.spend,
    expiredExtraMicros: w.expired,
    roles: [...w.roles].sort((x, y) => y[1] - x[1] || compare(x[0], y[0])).map(([role]) => role),
    money: w.money.kind()
  })).sort((x, y) => y.spendMicros - x.spendMicros || y.runs - x.runs || compare(x.key, y.key));

  expiredIdles.sort((x, y) => x - y);
  const topClaude = [...claudeSpend.values()].sort((x, y) => y.spend - x.spend)[0];
  const ratio = topClaude?.rates && topClaude.rates.cacheWrite !== undefined && topClaude.rates.cacheRead
    ? Math.round((topClaude.rates.cacheWrite / topClaude.rates.cacheRead) * 10) / 10
    : null;

  return {
    previousSpendMicros: previous.n > 0 ? previous.s : null,
    days: [...dayMap].sort(([x], [y]) => compare(x, y)).map(([date, d]) => ({ date, spendMicros: d.spend, expiredExtraMicros: d.expired })),
    agents: agentRows,
    cache: {
      rows: cacheRows,
      expiredWithinHour: expiredIdles.filter((idle) => idle <= HOUR).length,
      medianExpiredIdleMs: median(expiredIdles),
      wrote1h
    },
    tokens,
    wakes: wakeRows,
    priceDataDate,
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
