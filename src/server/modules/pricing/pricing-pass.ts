import type { Database } from "bun:sqlite";
import type { ProviderConfig } from "../../config/types.js";
import { providerBilling } from "../../../shared/settings.js";
import { logError } from "../../platform/logger.js";
import type { PriceCatalog } from "./catalog.js";
import { priceCall, type ConnectionPricing } from "./price-call.js";

const DEFAULT_BATCH = 500;
const DEFAULT_CLEAR_BATCHES_PER_TICK = 4;
/** Rows a clear batch looks at: bounded by rows examined, not by matches,
 *  so a connection with few calls in a long history costs no more per tick. */
const DEFAULT_CLEAR_WINDOW = 2000;
const DATA_VERSION_KEY = "data:version";
const CONNECTION_KEY = "conn:";
const CLEAR_KEY = "clear:";

interface Fingerprint {
  type: string;
  baseURL: string;
  billing: string;
  /** [model id, price], sorted: a model id can be any string, `__proto__` too. */
  prices: Array<[string, unknown]>;
}

/** What to clear so it is priced again: a connection's calls (a model's, when
 *  named), or every Unpriced call. */
interface ClearJob {
  name?: string;
  type?: string;
  baseURL?: string;
  model?: string;
  unpriced?: true;
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

const trimSlash = (url: string | null | undefined) => (url ?? "").trim().replace(/\/+$/, "");

function fingerprintOf(provider: ProviderConfig): Fingerprint {
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

/**
 * Prices calls in the background, in bounded steps: calls not priced yet
 * (new ones within a tick of finishing, and every call recorded before
 * pricing existed); a connection's calls again after its billing or a model's
 * price changes; Unpriced calls again after the price data changes. Priced
 * calls stay as priced when only the data changes: history should not move
 * with today's list. While the price data is on its way, calls wait.
 */
export class PricingPass {
  private readonly batchSize: number;
  private readonly clearBatchesPerTick: number;
  private readonly clearWindow: number;

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
  }) {
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH;
    this.clearBatchesPerTick = deps.clearBatchesPerTick ?? DEFAULT_CLEAR_BATCHES_PER_TICK;
    this.clearWindow = deps.clearWindow ?? DEFAULT_CLEAR_WINDOW;
  }

  tick(): void {
    try {
      const catalog = this.deps.data.catalog();
      this.noticeChanges(catalog);
      this.runClears();
      this.priceBatch(catalog);
    } catch (err) {
      logError("pricing-pass", err, "a pricing pass failed");
    }
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

  /** Settings and data compared with what the last pass saw; what changed is
   *  queued to be cleared. The first pass only records. */
  private noticeChanges(catalog: PriceCatalog): void {
    const version = catalog.dataInfo().version;
    const lastVersion = this.seen(DATA_VERSION_KEY);
    const firstPass = lastVersion === null;
    if (!firstPass && lastVersion !== version) this.queue({ unpriced: true });
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
        this.queue({ name, type: next.type, baseURL: next.baseURL });
        if (prev && (prev.type !== next.type || prev.baseURL !== next.baseURL)) this.queue({ name, type: prev.type, baseURL: prev.baseURL });
        continue;
      }
      const oldPrices = new Map(prev.prices);
      const newPrices = new Map(next.prices);
      for (const model of new Set([...oldPrices.keys(), ...newPrices.keys()])) {
        if (JSON.stringify(oldPrices.get(model)) !== JSON.stringify(newPrices.get(model))) {
          this.queue({ name, type: next.type, baseURL: next.baseURL, model });
        }
      }
    }
    for (const [name, prev] of before) {
      this.forget(CONNECTION_KEY + name);
      // Unreadable, it can only be cleared by name.
      if (!firstPass) this.queue({ name, type: prev?.type ?? "", baseURL: prev?.baseURL ?? "" });
    }
  }

  /** A few windows of the queued clears, each its own short statement. */
  private runClears(): void {
    let budget = this.clearBatchesPerTick;
    const jobs = this.deps.db.prepare("select key, value from pricing_seen where key like 'clear:%' order by key").all() as Array<{ key: string; value: string }>;
    for (const { key, value } of jobs) {
      const job = JSON.parse(key.slice(CLEAR_KEY.length)) as ClearJob;
      const progress = readProgress(value) ?? { cursor: 0, end: this.maxRowid() };
      while (budget > 0 && progress.cursor < progress.end) {
        budget -= 1;
        const to = Math.min(progress.cursor + this.clearWindow, progress.end);
        this.clearWindowOf(job, progress.cursor, to);
        progress.cursor = to;
      }
      if (progress.cursor >= progress.end) this.forget(key);
      else this.remember(key, JSON.stringify(progress));
      if (budget <= 0) return;
    }
  }

  private clearWindowOf(job: ClearJob, from: number, to: number): void {
    let where: string;
    let params: Array<string | number>;
    if (job.unpriced) {
      where = "cost_source = 'unpriced'";
      params = [];
    } else {
      // A connection's calls: those recorded under its name.
      where = `cost_source is not null and provider_name = ?${job.model !== undefined ? " and model = ?" : ""}`;
      params = [job.name ?? "", ...(job.model !== undefined ? [job.model] : [])];
    }
    this.deps.db.prepare(`
      update llm_calls set cost_source = null, cost_micros = null, cost_api_micros = null, cost_ref = null, cost_note = null
      where rowid > ? and rowid <= ? and ${where}
    `).run(from, to, ...params);
  }

  private priceBatch(catalog: PriceCatalog): void {
    const rows = this.deps.db.prepare(`
      select id, provider, provider_name, model, base_url, status, started_at, ttft_ms,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             cache_write_1h_tokens, service_tier, reported_cost_micros
      from llm_calls
      where cost_source is null and status not in ('running', 'pending')
      order by created_at desc
      limit ?
    `).all(this.batchSize) as PendingRow[];
    if (!rows.length) return;
    // Calls to price: ask for price data that is missing (asking is cheap
    // and holds back after a failure), and wait while the first try is out.
    this.deps.data.ensure?.();
    if (this.deps.data.ready && !this.deps.data.ready()) return;
    const providers = this.deps.providers();
    const update = this.deps.db.prepare(`
      update llm_calls set cost_micros = ?, cost_source = ?,
        cost_api_micros = ?, cost_ref = ?, cost_note = ?
      where id = ?
    `);
    this.deps.db.transaction(() => {
      for (const row of rows) {
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
          update.run(priced.micros, priced.source, priced.apiMicros, priced.ref ? JSON.stringify(priced.ref) : null, priced.note, row.id);
        } catch (err) {
          logError("pricing-pass", err, `call ${row.id} could not be priced`);
          update.run(null, "unpriced", null, null, null, row.id);
        }
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

