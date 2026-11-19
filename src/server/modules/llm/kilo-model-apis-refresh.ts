import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderConfig } from "../../config.js";
import {
  kiloModelApisSnapshot,
  replaceKiloModelApis,
  restoreKiloModelApis,
  type KiloApi
} from "../../config/kilo-model-apis.js";
import type { HttpClient } from "../../platform/http/http-client.js";
import { logError } from "../../platform/logger.js";
import { fetchProviderModels } from "../settings/provider-models.js";

const FILE = "kilo-model-apis.json";
const REFRESH_EVERY_MS = 24 * 60 * 60_000;

export interface KiloModelApisRefresher {
  /** Restores the saved tags; calls onChange when they differ from memory. */
  load(): Promise<void>;
  /** Reads every Kilo connection's /models now; saves and calls onChange when
   *  a tag changed. A connection whose listing fails keeps its last tags. */
  refresh(): Promise<void>;
  /** A listing read elsewhere (Settings): taken as a refresh of that connection. */
  accept(connection: string, apis: ReadonlyMap<string, KiloApi>): void;
  /** Refreshes now and once a day after. */
  start(): void;
  dispose(): void;
}

/**
 * Keeps Kilo's per-model tags (config/kilo-model-apis.ts) current: the saved
 * copy at start, then each Kilo connection's own /models (Bearer key and the
 * organisation, as Kilo's client sends them) at start and once a day. A tag
 * that changes reaches running models through onChange (a config reload).
 */
export function createKiloModelApisRefresher(deps: {
  dataDir: string;
  http: HttpClient;
  providers: () => Record<string, ProviderConfig>;
  onChange: () => void;
}): KiloModelApisRefresher {
  let timer: ReturnType<typeof setInterval> | null = null;
  const path = join(deps.dataDir, FILE);

  const save = () => {
    try {
      mkdirSync(deps.dataDir, { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), apis: kiloModelApisSnapshot() }));
      renameSync(tmp, path);
    } catch (e) {
      logError("kilo-model-apis", e, "the Kilo model tags could not be saved");
    }
  };

  // The list Settings reads (fetchProviderModels): one request shape for both.
  // A failed listing has no tags, so the connection keeps its last ones.
  const listing = async (provider: ProviderConfig): Promise<ReadonlyMap<string, KiloApi> | null> =>
    (await fetchProviderModels(provider, { httpClient: deps.http })).kiloApis ?? null;

  // A change reaches running models through a config reload; one that fails
  // keeps the tags taken and the refreshes going.
  const changed = () => {
    try {
      deps.onChange();
    } catch (e) {
      logError("kilo-model-apis", e, "the config reload after a Kilo tag change failed");
    }
  };

  return {
    async load() {
      let saved: unknown;
      try {
        saved = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return;
      }
      if (restoreKiloModelApis((saved as { apis?: unknown } | null)?.apis)) changed();
    },
    async refresh() {
      let anyChanged = false;
      for (const [connection, provider] of Object.entries(deps.providers())) {
        if (provider.type !== "kilo" || !provider.apiKey || !provider.baseURL) continue;
        const apis = await listing(provider);
        if (apis && replaceKiloModelApis(connection, apis)) anyChanged = true;
      }
      if (!anyChanged) return;
      save();
      changed();
    },
    accept(connection, apis) {
      if (!replaceKiloModelApis(connection, apis)) return;
      save();
      changed();
    },
    start() {
      if (timer) return;
      void this.refresh();
      timer = setInterval(() => { void this.refresh(); }, REFRESH_EVERY_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
