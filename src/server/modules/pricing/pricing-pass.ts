import type { Database } from "bun:sqlite";
import type { ProviderConfig } from "../../config/types.js";
import { providerBilling } from "../../../shared/settings.js";
import { logError } from "../../platform/logger.js";
import type { PriceCatalog } from "./catalog.js";
import { priceCall, type ConnectionPricing } from "./price-call.js";

const DEFAULT_BATCH = 500;
const DEFAULT_CLEAR_BATCHES_PER_TICK = 4;
/** Rows a clear batch looks at: bounded by rows examined, not by matches,
 *  so a connection with few calls in a long history costs no more per tick.
 *  A call keeps its reply's words for a while, so a window reads whole rows:
 *  500 kept one under a quarter second on a loaded machine (2,000 took a
 *  second). */
const DEFAULT_CLEAR_WINDOW = 500;
/** What a tick may hold the server's thread for: each part of it (clears,
 *  prices again, new calls) does one step at least, then stops once this is
 *  spent, and the rest waits for the next tick. */
const TICK_BUDGET_MS = 50;
/** How far back a change of the price data reaches: the Unpriced calls of
 *  these last days are priced again. Older ones stay as they were: a model
 *  no list has priced in a month is one none will (a gateway's own name). */
const REPRICE_DAYS = 30;
/** Unpriced calls read at a time while pricing them again. */
const REPRICE_CHUNK = 100;
const DATA_VERSION_KEY = "data:version";
const CONNECTION_KEY = "conn:";
const CLEAR_KEY = "clear:";
const REPRICE_KEY = "reprice:unpriced";

export interface Fingerprint {
  type: string;
  baseURL: string;
  billing: string;
  /** [model id, price], sorted: a model id can be any string, `__proto__` too. */
  prices: Array<[string, unknown]>;
}

/** What to clear so it is priced again: a connection's calls (a model's, when
 *  named), found by the connection's name. */
interface ClearJob {
  name: string;
  model?: string;
}

interface PendingRow {
  id: string;
  provider: string;
  provider_name: string | null;
  model: string;
  base_url: string;
  status: string;
  started_at: string;
  ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_1h_tokens: number | null;
  service_tier: string | null;
  reported_cost_micros: number | null;
}

/** An Unpriced call as stored, priced again where it is. */
interface StoredRow extends PendingRow {
  rowid: number;
  cost_micros: number | null;
  cost_source: string | null;
  cost_api_micros: number | null;
  cost_ref: string | null;
  cost_note: string | null;
}

/** A call's price as written to its row. */
interface PricedRow {
  micros: number | null;
  source: string;
  apiMicros: number | null;
  ref: string | null;
  note: string | null;
}

const PRICING_COLUMNS = `id, provider, provider_name, model, base_url, status, started_at, ttft_ms,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cache_write_1h_tokens, service_tier, reported_cost_micros`;

const trimSlash = (url: string | null | undefined) => (url ?? "").trim().replace(/\/+$/, "");

/** What prices calls besides the price lists: each connection's price
 *  settings, by name. The pass re-prices when it changes, and Activity's
 *  kept slices are worked out again (activity-rollup's rollupInputs). */
export function priceSettingsOf(providers: Record<string, ProviderConfig>): Array<[string, Fingerprint]> {
  return Object.keys(providers).sort().map((name) => [name, fingerprintOf(providers[name]!)]);
}

export function fingerprintOf(provider: ProviderConfig): Fingerprint {
  const prices = provider.models
    .filter((model) => model.price)
    .map((model): [string, unknown] => [model.id, model.price])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { type: provider.type, baseURL: trimSlash(provider.baseURL), billing: providerBilling(provider), prices };
}

/** Where a queued clear has got to: rows after `cursor`, up to `end` (the
 *  last row when it was queued; later rows were priced with the new settings). */
interface ClearProgress {
  cursor: number;
  end: number;
}

/** Where the re-price has got to, in the order calls were recorded: after
 *  the call recorded at `at` (`rowid` among those at the same time), up to
 *  `end`, the last call when it was queued (later ones were priced with the
 *  new data). */
interface RepriceProgress {
  at: string;
  rowid: number;
  end: number;
}

/**
 * Prices calls in the background, in bounded steps: calls not priced yet
 * (new ones within a tick of finishing); a connection's calls again after its billing or a model's
 * price changes; the last 30 days' Unpriced calls again after the price data
 * changes, where they are, writing only those it now prices. Priced calls
 * stay as priced when only the data changes: history should not move with
 * today's list. While the price data is on its way, calls wait. A tick holds
 * the server's thread for about 50 ms at most.
 */
export class PricingPass {
  private readonly batchSize: number;
  private readonly clearBatchesPerTick: number;
  private readonly clearWindow: number;
  private readonly now: () => number;
  /** The settings as the last tick found them; null before the first. */
  private looked: string | null = null;

  constructor(private readonly deps: {
    db: Database;
    data: {
      catalog(): PriceCatalog;
      /** Whether pricing need not wait for price data. */
      ready?(): boolean;
      /** Asks for the price data when it is missing. */
      ensure?(): void;
    };
    providers: () => Record<string, ProviderConfig>;
    batchSize?: number;
    clearBatchesPerTick?: number;
    clearWindow?: number;
    /** Milliseconds, for a tick's budget and the 30 days back. */
    now?: () => number;
  }) {
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH;
    this.clearBatchesPerTick = deps.clearBatchesPerTick ?? DEFAULT_CLEAR_BATCHES_PER_TICK;
    this.clearWindow = deps.clearWindow ?? DEFAULT_CLEAR_WINDOW;
    this.now = deps.now ?? Date.now;
  }

  tick(): void {
    try {
      const deadline = this.now() + TICK_BUDGET_MS;
      const catalog = this.deps.data.catalog();
      this.noticeChanges(catalog);
      this.looked = this.settings(catalog);
      this.runClears(deadline);
      this.repriceUnpriced(catalog, deadline);
      this.priceBatch(catalog, deadline);
    } catch (err) {
      logError("pricing-pass", err, "a pricing pass failed");
    }
  }

  /** What a tick compares with what the last one saw: the price data's
   *  version and every connection's price settings. */
  private settings(catalog: PriceCatalog): string {
    return JSON.stringify([catalog.dataInfo().version, priceSettingsOf(this.deps.providers())]);
  }

  /**
   * Whether the pass has nothing left to write into stored calls: a tick has
   * looked at the settings in use (a change queues its work only then, and
   * a restart learns only then what was left queued), no clear and no
   * re-price is queued, and no finished call waits for a price (a cleared
   * call waits to be priced again). Work that reads the calls in bulk and
   * would be undone by those writes waits for this.
   */
  idle(): boolean {
    if (this.looked === null || this.looked !== this.settings(this.deps.data.catalog())) return false;
    const queued = this.deps.db.prepare("select 1 from pricing_seen where key like 'clear:%' or key = ? limit 1").get(REPRICE_KEY);
    if (queued) return false;
    return !this.deps.db.prepare("select 1 from llm_calls where cost_source is null and status <> 'running' limit 1").get();
  }

  private seen(key: string): string | null {
    const row = this.deps.db.prepare("select value from pricing_seen where key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  private remember(key: string, value: string): void {
    this.deps.db.prepare("insert into pricing_seen (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  private forget(key: string): void {
    this.deps.db.prepare("delete from pricing_seen where key = ?").run(key);
  }

  private maxRowid(): number {
    return (this.deps.db.prepare("select coalesce(max(rowid), 0) m from llm_calls").get() as { m: number }).m;
  }

  /** Queued (again, from the start, when it already was). */
  private queue(job: ClearJob): void {
    this.remember(CLEAR_KEY + JSON.stringify(job), JSON.stringify({ cursor: 0, end: this.maxRowid() } satisfies ClearProgress));
  }

  /** The last 30 days' Unpriced calls to price again (from their start
   *  again, when they already were), up to the last call now; later ones are
   *  priced with the new data anyway. */
  private queueReprice(): void {
    const since = new Date(this.now() - REPRICE_DAYS * 86_400_000).toISOString();
    this.remember(REPRICE_KEY, JSON.stringify({ at: since, rowid: 0, end: this.maxRowid() } satisfies RepriceProgress));
  }

  /** Settings and data compared with what the last pass saw; what changed is
   *  queued to be cleared. The first pass only records. */
  private noticeChanges(catalog: PriceCatalog): void {
    const version = catalog.dataInfo().version;
    const lastVersion = this.seen(DATA_VERSION_KEY);
    const firstPass = lastVersion === null;
    if (!firstPass && lastVersion !== version) this.queueReprice();
    if (lastVersion !== version) this.remember(DATA_VERSION_KEY, version);

    const providers = this.deps.providers();
    const stored = this.deps.db.prepare("select key, value from pricing_seen where key like 'conn:%'").all() as Array<{ key: string; value: string }>;
    const before = new Map(stored.map((row) => [row.key.slice(CONNECTION_KEY.length), readFingerprint(row.value)]));
    for (const [name, provider] of Object.entries(providers)) {
      const next = fingerprintOf(provider);
      const prev = before.get(name);
      before.delete(name);
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) continue;
      this.remember(CONNECTION_KEY + name, JSON.stringify(next));
      if (firstPass) continue;
      // A fingerprint that cannot be read is treated as the whole connection changed.
      if (!prev || !Array.isArray(prev.prices) || prev.type !== next.type || prev.baseURL !== next.baseURL || prev.billing !== next.billing) {
        this.queue({ name });
        continue;
      }
      const oldPrices = new Map(prev.prices);
      const newPrices = new Map(next.prices);
      for (const model of new Set([...oldPrices.keys(), ...newPrices.keys()])) {
        if (JSON.stringify(oldPrices.get(model)) !== JSON.stringify(newPrices.get(model))) {
          this.queue({ name, model });
        }
      }
    }
    for (const name of before.keys()) {
      this.forget(CONNECTION_KEY + name);
      if (!firstPass) this.queue({ name });
    }
  }

  /** A few windows of the queued clears, each its own short statement: one
   *  at least, then while the tick's time lasts. */
  private runClears(deadline: number): void {
    let budget = this.clearBatchesPerTick;
    const jobs = this.deps.db.prepare("select key, value from pricing_seen where key like 'clear:%' order by key").all() as Array<{ key: string; value: string }>;
    for (const { key, value } of jobs) {
      const job = JSON.parse(key.slice(CLEAR_KEY.length)) as ClearJob;
      const progress = readProgress(value) ?? { cursor: 0, end: this.maxRowid() };
      let spent = false;
      while (budget > 0 && progress.cursor < progress.end) {
        budget -= 1;
        const to = Math.min(progress.cursor + this.clearWindow, progress.end);
        this.clearWindowOf(job, progress.cursor, to);
        progress.cursor = to;
        if (this.now() >= deadline) {
          spent = true;
          break;
        }
      }
      if (progress.cursor >= progress.end) this.forget(key);
      else this.remember(key, JSON.stringify(progress));
      if (budget <= 0 || spent) return;
    }
  }

  /** The queued re-price: the Unpriced calls, read through their own index a
   *  few at a time, priced with the data as it is now, and written only when
   *  that changes their price. One read at least, then while the tick's time
   *  lasts. */
  private repriceUnpriced(catalog: PriceCatalog, deadline: number): void {
    const value = this.seen(REPRICE_KEY);
    if (value === null) return;
    if (this.deps.data.ready && !this.deps.data.ready()) return;
    const progress = readRepriceProgress(value);
    if (!progress) {
      // Unreadable: from its start again.
      this.queueReprice();
      return;
    }
    // In the order recorded, as their index has them: by time, then rowid.
    const read = this.deps.db.prepare(`
      select rowid, created_at, ${PRICING_COLUMNS}, cost_micros, cost_source, cost_api_micros, cost_ref, cost_note
      from llm_calls
      where cost_source = 'unpriced' and (created_at, rowid) > (?, ?) and rowid <= ?
      order by created_at, rowid
      limit ?
    `);
    const update = this.updateStatement();
    const providers = this.deps.providers();
    let done = false;
    while (!done) {
      const rows = read.all(progress.at, progress.rowid, progress.end, REPRICE_CHUNK) as Array<StoredRow & { created_at: string }>;
      const changed = rows.flatMap((row) => {
        const priced = this.priceRow(row, providers, catalog);
        const same = priced.micros === row.cost_micros && priced.source === row.cost_source && priced.apiMicros === row.cost_api_micros
          && priced.ref === row.cost_ref && priced.note === row.cost_note;
        return same ? [] : [{ id: row.id, priced }];
      });
      if (changed.length) {
        this.deps.db.transaction(() => {
          for (const { id, priced } of changed) update.run(priced.micros, priced.source, priced.apiMicros, priced.ref, priced.note, id);
        })();
      }
      const last = rows.at(-1);
      if (last) {
        progress.at = last.created_at;
        progress.rowid = last.rowid;
      }
      done = rows.length < REPRICE_CHUNK;
      if (this.now() >= deadline) break;
    }
    if (done) this.forget(REPRICE_KEY);
    else this.remember(REPRICE_KEY, JSON.stringify(progress));
  }

  private updateStatement() {
    return this.deps.db.prepare(`
      update llm_calls set cost_micros = ?, cost_source = ?,
        cost_api_micros = ?, cost_ref = ?, cost_note = ?
      where id = ?
    `);
  }

  /** A call's price with the connection it was made through and the data as
   *  it is now; Unpriced when pricing it fails. */
  private priceRow(row: PendingRow, providers: Record<string, ProviderConfig>, catalog: PriceCatalog): PricedRow {
    const connection = connectionFor({ providerName: row.provider_name }, providers);
    // A connection no longer there bills as its type does by default:
    // a ChatGPT sign-in's history stays Included rather than turning
    // into spend at the list price.
    const pricing: ConnectionPricing = connection
      ? { billing: providerBilling(connection), price: connection.models.find((m) => m.id === row.model)?.price }
      : { billing: providerBilling({ type: row.provider }) };
    try {
      const priced = priceCall({
        providerType: connection?.type ?? row.provider,
        baseURL: row.base_url,
        model: row.model,
        startedAt: row.started_at,
        status: row.status,
        ttftMs: row.ttft_ms,
        usage: {
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read_tokens,
          cacheWrite: row.cache_write_tokens,
          cacheWrite1h: row.cache_write_1h_tokens
        },
        serviceTier: row.service_tier,
        reportedMicros: row.reported_cost_micros
      }, pricing, catalog);
      return { micros: priced.micros, source: priced.source, apiMicros: priced.apiMicros, ref: priced.ref ? JSON.stringify(priced.ref) : null, note: priced.note };
    } catch (err) {
      logError("pricing-pass", err, `call ${row.id} could not be priced`);
      return { micros: null, source: "unpriced", apiMicros: null, ref: null, note: null };
    }
  }

  private clearWindowOf(job: ClearJob, from: number, to: number): void {
    // A connection's calls: those recorded under its name. Looked for in
    // the window's rowids: `+` keeps SQLite off the index that leads with
    // the name (idx_llm_calls_models), which would walk every call of the
    // connection for each window.
    const where = `cost_source is not null and +provider_name = ?${job.model !== undefined ? " and model = ?" : ""}`;
    const params: Array<string | number> = [job.name, ...(job.model !== undefined ? [job.model] : [])];
    this.deps.db.prepare(`
      update llm_calls set cost_source = null, cost_micros = null, cost_api_micros = null, cost_ref = null, cost_note = null
      where rowid > ? and rowid <= ? and ${where}
    `).run(from, to, ...params);
  }

  /** Calls not priced yet, newest first: one at least, then while the
   *  tick's time lasts, in one transaction. */
  private priceBatch(catalog: PriceCatalog, deadline: number): void {
    const rows = this.deps.db.prepare(`
      select ${PRICING_COLUMNS}
      from llm_calls
      where cost_source is null and status <> 'running'
      order by created_at desc
      limit ?
    `).all(this.batchSize) as PendingRow[];
    if (!rows.length) return;
    // Calls to price: ask for price data that is missing (asking is cheap
    // and holds back after a failure), and wait while the first try is out.
    this.deps.data.ensure?.();
    if (this.deps.data.ready && !this.deps.data.ready()) return;
    const providers = this.deps.providers();
    const update = this.updateStatement();
    this.deps.db.transaction(() => {
      for (const row of rows) {
        const priced = this.priceRow(row, providers, catalog);
        update.run(priced.micros, priced.source, priced.apiMicros, priced.ref, priced.note, row.id);
        if (this.now() >= deadline) break;
      }
    })();
  }
}

/** Stored state that cannot be read is redone from the start rather than
 *  trusted or left stuck. */
function readFingerprint(value: string): Fingerprint | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Fingerprint) : undefined;
  } catch {
    return undefined;
  }
}

function readRepriceProgress(value: string): RepriceProgress | null {
  try {
    const parsed = JSON.parse(value) as Partial<RepriceProgress> | null;
    return parsed && typeof parsed.at === "string" && Number.isFinite(parsed.rowid) && Number.isFinite(parsed.end)
      ? { at: parsed.at, rowid: parsed.rowid!, end: parsed.end! }
      : null;
  } catch {
    return null;
  }
}

function readProgress(value: string): ClearProgress | null {
  try {
    const parsed = JSON.parse(value) as Partial<ClearProgress> | null;
    return parsed && Number.isFinite(parsed.cursor) && Number.isFinite(parsed.end) ? { cursor: parsed.cursor!, end: parsed.end! } : null;
  } catch {
    return null;
  }
}

/** The connection a call was made through: the one it was stored under. */
export function connectionFor(
  row: { providerName: string | null },
  providers: Record<string, ProviderConfig>
): ProviderConfig | undefined {
  const name = row.providerName;
  return name && Object.hasOwn(providers, name) ? providers[name] : undefined;
}

