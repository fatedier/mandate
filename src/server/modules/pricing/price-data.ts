import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../../../shared/guards.js";
import type { HttpClient } from "../../platform/http/http-client.js";
import { logError } from "../../platform/logger.js";
import { createPriceCatalog, type PriceCatalog } from "./catalog.js";
import { LITELLM_PRICES_URL, trimLitellm, type LitellmPrices } from "./litellm.js";
import { MODELS_DEV_URL, trimModelsDev, type ModelsDevPrices } from "./models-dev.js";

const REQUEST_TIMEOUT_MS = 30_000;
/** After a download of missing data failed, the next try waits this long. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

export type RefreshResult = "updated" | "unchanged" | "kept" | "off";

interface Meta {
  etag?: string;
  lastModified?: string;
  date?: string;
}

type SourceName = "litellm" | "models-dev";

const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];

/** Rates as the calculator reads them, every optional part checked: a saved
 *  copy edited or cut wrong must not reach pricing. */
function isRateSet(value: unknown, complete: boolean): boolean {
  if (!isRecord(value)) return false;
  if (complete && (!finite(value.input) || !finite(value.output))) return false;
  return Object.entries(value).every(([key, rate]) => RATE_FIELDS.includes(key) && finite(rate));
}
function isTiers(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((t) => isRecord(t) && finite(t.above) && isRateSet(t.rates, false)));
}
function hasCoreRates(rates: unknown): boolean {
  return isRecord(rates) && isRateSet(rates.base, true) && isTiers(rates.tiers) &&
    (["flex", "priority"] as const).every((service) => rates[service] === undefined ||
      (isRecord(rates[service]) && isRateSet((rates[service] as Record<string, unknown>).base, false) && isTiers((rates[service] as Record<string, unknown>).tiers)));
}

function isLitellmPrices(value: unknown): value is LitellmPrices {
  return isRecord(value) && typeof value.date === "string" && isRecord(value.entries) &&
    Object.values(value.entries).every((e) => isRecord(e) && typeof e.provider === "string" && hasCoreRates(e.rates));
}

function isModelsDevPrices(value: unknown): value is ModelsDevPrices {
  return isRecord(value) && typeof value.date === "string" && Array.isArray(value.plans) &&
    value.plans.every((p) => isRecord(p) && typeof p.id === "string" && typeof p.api === "string") &&
    Array.isArray(value.providers) && value.providers.every((p) =>
      isRecord(p) && typeof p.id === "string" && typeof p.name === "string" && typeof p.api === "string" && Array.isArray(p.models) &&
      p.models.every((m) => isRecord(m) && typeof m.id === "string" && hasCoreRates(m.rates)));
}

const litellmCount = (data: LitellmPrices | null) => (data ? Object.keys(data.entries).length : 0);
const modelsDevCount = (data: ModelsDevPrices | null) => (data ? data.providers.reduce((n, p) => n + p.models.length, 0) : 0);

/** Shrinking to under half the models a source had is a broken file, not news. */
const notShrunk = (next: number, current: number) => next >= Math.floor(current / 2) && next > 0;

/**
 * The price data the catalog prices with: LiteLLM's price table and
 * models.dev, neither shipped with Mandate. Each is downloaded when first
 * needed and then daily, trimmed, and saved in `<dataDir>/prices/`; a saved
 * copy is used from the next start. A download is used only when it parses,
 * has the expected shape and has not lost more than half its models; anything
 * else keeps the data in use. With automatic updates off, nothing is fetched.
 */
export class PriceData {
  private litellm: LitellmPrices | null = null;
  private modelsDev: ModelsDevPrices | null = null;
  private current: PriceCatalog;
  private readonly listeners: Array<() => void> = [];
  /** The saved copies in use: only theirs are sent as validators, so a copy
   *  that was set aside never earns a 304 that keeps it from being replaced. */
  private readonly savedInUse = new Set<SourceName>();
  private readonly now: () => Date;
  /** A download has finished (whatever its result) since the start. */
  private attempted = false;
  private downloading: Promise<unknown> | null = null;
  private lastTry = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: { dataDir: string; http: HttpClient; autoUpdate: () => boolean; now?: () => Date }) {
    this.now = deps.now ?? (() => new Date());
    this.current = this.build();
  }

  async load(): Promise<void> {
    const litellm = this.readSaved("litellm");
    if (litellm && isLitellmPrices(litellm.data)) {
      this.litellm = litellm.data;
      this.savedInUse.add("litellm");
    }
    const modelsDev = this.readSaved("models-dev");
    if (modelsDev && isModelsDevPrices(modelsDev.data)) {
      this.modelsDev = modelsDev.data;
      this.savedInUse.add("models-dev");
    }
    this.rebuild();
  }

  catalog(): PriceCatalog {
    return this.current;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Whether pricing need not wait: both lists are here, a download has been
   *  tried, or nothing will be fetched. */
  ready(): boolean {
    return !this.deps.autoUpdate() || (this.litellm !== null && this.modelsDev !== null) || this.attempted;
  }

  /** Resolves when the download in flight ends, or after `timeoutMs`; at
   *  once when none is. A request that needs the data waits on it. */
  async whenSettled(timeoutMs: number): Promise<void> {
    const downloading = this.downloading;
    if (!downloading) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([downloading, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
  }

  /** Downloads the lists when one is missing: one download at a time, and
   *  after a failed one not again for an hour. */
  ensure(): void {
    if (!this.deps.autoUpdate() || this.downloading || (this.litellm && this.modelsDev)) return;
    const at = this.now().getTime();
    if (at - this.lastTry < RETRY_AFTER_MS) return;
    this.lastTry = at;
    this.downloading = this.refresh()
      .catch((err) => logError("price data: could not download price data", err))
      .finally(() => { this.downloading = null; });
  }

  async refresh(): Promise<{ litellm: RefreshResult; modelsDev: RefreshResult }> {
    if (!this.deps.autoUpdate()) return { litellm: "off", modelsDev: "off" };
    try {
      const litellm = await this.refreshOne("litellm", LITELLM_PRICES_URL, (body, date) => {
        const trimmed = trimLitellm(JSON.parse(body), date);
        if (!notShrunk(litellmCount(trimmed), litellmCount(this.litellm))) return null;
        return { text: JSON.stringify(trimmed), apply: () => { this.litellm = trimmed; } };
      });
      const modelsDev = await this.refreshOne("models-dev", MODELS_DEV_URL, (body, date) => {
        const trimmed = trimModelsDev(JSON.parse(body), date);
        if (!notShrunk(modelsDevCount(trimmed), modelsDevCount(this.modelsDev))) return null;
        return { text: JSON.stringify(trimmed), apply: () => { this.modelsDev = trimmed; } };
      });
      if (litellm === "updated" || modelsDev === "updated") {
        this.rebuild();
        for (const listener of this.listeners) {
          try {
            listener();
          } catch (err) {
            logError("price data: a change listener failed", err);
          }
        }
      }
      return { litellm, modelsDev };
    } finally {
      this.attempted = true;
    }
  }

  private async refreshOne(
    name: SourceName,
    url: string,
    accept: (body: string, date: string) => { text: string; apply: () => void } | null
  ): Promise<RefreshResult> {
    const meta = this.savedInUse.has(name) ? this.readSaved(name)?.meta ?? {} : {};
    let body: string;
    let response: Response;
    try {
      const headers: Record<string, string> = {};
      if (meta.etag) headers["if-none-match"] = meta.etag;
      if (meta.lastModified) headers["if-modified-since"] = meta.lastModified;
      response = await this.deps.http.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 304) return "unchanged";
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      body = await response.text();
    } catch (err) {
      logError(`price data: could not download ${name}; keeping what is in use`, err);
      return "kept";
    }
    const date = this.now().toISOString().slice(0, 10);
    let accepted: { text: string; apply: () => void } | null;
    try {
      accepted = accept(body, date);
    } catch {
      accepted = null;
    }
    if (!accepted) {
      logError(`price data: the ${name} download did not look right; keeping what is in use`, null);
      return "kept";
    }
    accepted.apply();
    const nextMeta: Meta = {
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
      date
    };
    this.save(name, accepted.text, nextMeta);
    this.savedInUse.add(name);
    return "updated";
  }

  private build(): PriceCatalog {
    return createPriceCatalog({ litellm: this.litellm, modelsDev: this.modelsDev });
  }

  private rebuild(): void {
    this.current = this.build();
  }

  private dir(): string {
    return path.join(this.deps.dataDir, "prices");
  }

  private readSaved(name: SourceName): { data: unknown; meta: Meta } | null {
    try {
      const file = path.join(this.dir(), `${name}.json`);
      if (!fs.existsSync(file)) return null;
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const metaFile = path.join(this.dir(), `${name}.meta.json`);
      const meta: unknown = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
      return { data, meta: isRecord(meta) ? (meta as Meta) : {} };
    } catch {
      return null;
    }
  }

  /** Through a temp file and a rename; a data dir that cannot be written
   *  leaves the downloaded data in use until the next start. */
  private save(name: SourceName, text: string, meta: Meta): void {
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      for (const [file, contents] of [[`${name}.json`, text], [`${name}.meta.json`, JSON.stringify(meta)]] as const) {
        const target = path.join(this.dir(), file);
        const temp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temp, contents);
        fs.renameSync(temp, target);
      }
    } catch (err) {
      logError(`price data: could not save the ${name} download`, err);
    }
  }
}
