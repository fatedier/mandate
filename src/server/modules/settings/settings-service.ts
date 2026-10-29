import { createHash } from "node:crypto";
import {
  deleteCodexAuthProfile,
  getCodexAuthStatus,
  type CodexAuthStorage
} from "../codex/codex-auth-store.js";
import { getCodexBrowserLoginStatus, startCodexBrowserLogin } from "../codex/codex-oauth.js";
import {
  systemExternalOpener,
  type ExternalOpener
} from "../../platform/os/external-opener.js";
import type { HttpClient } from "../../platform/http/http-client.js";
import { createConfigStore } from "../../config/config-store.js";
import { loadConfig, type Config } from "../../config.js";
import type { JsonStore } from "../../platform/storage/json-store.js";
import type { SettingsConfigPayload } from "../../../shared/settings.js";
import type { ProviderCheckResult } from "../../../shared/api-contracts.js";
import {
  applySettingsConfigPatch,
  isJsonObject,
  isValidProviderName,
  type JsonObject
} from "./config-schema.js";
import {
  fetchProviderModels,
  type ProviderModelsResult
} from "./provider-models.js";
import { buildSettingsConfigPayload } from "./settings-payload.js";
import type { KiloApi } from "../../config/kilo-model-apis.js";

interface SettingsServiceDeps {
  opener?: ExternalOpener;
  configStore?: JsonStore<JsonObject>;
  codexAuthStore?: CodexAuthStorage;
  httpClient?: HttpClient;
  reloadConfig?: () => Config;
  /** A Kilo listing's per-model API tags, for the registry (a changed tag
   *  reloads the config). */
  onKiloModelApis?: (connection: string, apis: ReadonlyMap<string, KiloApi>) => void;
}

export class SettingsService {
  private providerModelCache = new Map<string, { createdAt: number; result: ProviderModelsResult }>();
  /** Each provider's last check, with what it depended on. */
  private providerChecks = new Map<string, { key: string; at: number; result: ProviderCheckResult }>();

  constructor(private deps: SettingsServiceDeps = {}) {}

  getConfigPayload(restartRequired: boolean): SettingsConfigPayload {
    return buildSettingsConfigPayload(restartRequired, {
      configStore: this.deps.configStore,
      codexAuthStore: this.deps.codexAuthStore
    });
  }

  updateConfig(payload: unknown): SettingsConfigPayload {
    const configStore = this.deps.configStore ?? createConfigStore();
    const before = loadConfig(undefined, configStore);
    writeSettingsConfig(payload, configStore);
    this.providerModelCache.clear();
    const after = this.deps.reloadConfig?.() ?? loadConfig(undefined, configStore);
    return buildSettingsConfigPayload(restartRequiredForConfigChange(before, after), {
      config: after,
      configStore,
      codexAuthStore: this.deps.codexAuthStore
    });
  }

  async startCodexLogin(payload: unknown) {
    const providerName = providerNameFromPayload(payload);
    const login = await startCodexBrowserLogin(providerName, {
      httpClient: this.deps.httpClient,
      authStore: this.deps.codexAuthStore
    });
    return {
      status: "pending" as const,
      opened: (this.deps.opener ?? systemExternalOpener).openUrl(login.url),
      ...login
    };
  }

  getCodexLoginStatus(requestId: string) {
    return getCodexBrowserLoginStatus(requestId);
  }

  logoutCodex(payload: unknown) {
    const providerName = providerNameFromPayload(payload);
    deleteCodexAuthProfile(providerName, this.deps.codexAuthStore ?? undefined);
    return { auth: getCodexAuthStatus(providerName, this.deps.codexAuthStore ?? undefined) };
  }

  async listProviderModels(providerName: string, opts: { refresh?: boolean } = {}) {
    if (!providerName || !isValidProviderName(providerName)) {
      throw new Error("providerName is invalid");
    }

    const configStore = this.deps.configStore ?? createConfigStore();
    const config = loadConfig(undefined, configStore);
    const provider = config.models.providers[providerName];
    if (!provider) throw new Error(`provider not found: ${providerName}`);

    const cacheKey = providerModelCacheKey(providerName, provider);
    const cached = this.providerModelCache.get(cacheKey);
    if (!opts.refresh && cached && Date.now() - cached.createdAt < 60 * 60_000) {
      return {
        providerName,
        ...cached.result,
        cached: true
      };
    }

    const { kiloApis, ...result } = await fetchProviderModels(provider, { httpClient: this.deps.httpClient });
    if (kiloApis) this.deps.onKiloModelApis?.(providerName, kiloApis);
    // Never cache the configured-only fallback: it may be a transient live
    // failure, and pinning it for an hour turns a blip into "unavailable"
    // until the user finds the Refresh button. Recomputing it is free.
    if (result.source !== "configured") {
      this.providerModelCache.set(cacheKey, { createdAt: Date.now(), result });
    } else {
      this.providerModelCache.delete(cacheKey);
    }
    return {
      providerName,
      ...result,
      cached: false
    };
  }

  /**
   * Whether the provider answers with its saved settings: its model list,
   * read now or within `maxAgeMs` of the last read for the same settings.
   * No prompt is sent. A replaced key, URL or organization is never
   * answered from an older result.
   */
  async checkProvider(
    providerName: string,
    opts: { maxAgeMs?: number } = {}
  ): Promise<{ providerName: string } & ProviderCheckResult> {
    if (!providerName || !isValidProviderName(providerName)) {
      throw new Error("providerName is invalid");
    }
    const configStore = this.deps.configStore ?? createConfigStore();
    const provider = loadConfig(undefined, configStore).models.providers[providerName];
    if (!provider) throw new Error(`provider not found: ${providerName}`);
    if (provider.type === "codex") return { providerName, result: "unchecked", reason: "signed-in-only" };
    if (!provider.apiKey) return { providerName, result: "unchecked", reason: "no-key" };

    const key = providerCheckKey(providerName, provider);
    const kept = this.providerChecks.get(providerName);
    // Only a ready answer is reused: a failure may be a passing blip, and
    // kept for an hour it would paint the provider red for that hour.
    if (kept && kept.key === key && kept.result.result === "ready" && Date.now() - kept.at < (opts.maxAgeMs ?? 0)) {
      return { providerName, ...kept.result };
    }
    // Kilo's tags go to the registry, not into the catalog Settings answers with.
    const { kiloApis, ...listing } = await fetchProviderModels(provider, { httpClient: this.deps.httpClient });
    if (kiloApis) this.deps.onKiloModelApis?.(providerName, kiloApis);
    const checkedAt = new Date().toISOString();
    const result: ProviderCheckResult = listing.source === "live"
      ? { result: "ready", modelCount: listing.listedCount ?? listing.models.length, checkedAt }
      : {
          result: "failed",
          message: listing.failure?.message ?? "The provider didn't list its models.",
          ...(listing.failure?.httpStatus ? { httpStatus: listing.failure.httpStatus } : {}),
          checkedAt
        };
    this.providerChecks.set(providerName, { key, at: Date.now(), result });
    // A live answer is also the freshest catalog for Add models.
    if (listing.source === "live") {
      this.providerModelCache.set(providerModelCacheKey(providerName, provider), { createdAt: Date.now(), result: listing });
    }
    return { providerName, ...result };
  }
}

function restartRequiredForConfigChange(before: Config, after: Config): boolean {
  return before.host !== after.host
    || before.port !== after.port;
}

function writeSettingsConfig(payload: unknown, configStore: JsonStore<JsonObject>) {
  const current = configStore.read();
  configStore.write(applySettingsConfigPatch(current, payload));
}

function providerNameFromPayload(payload: unknown) {
  if (!isJsonObject(payload)) throw new Error("payload must be an object");
  const providerName = typeof payload.providerName === "string" ? payload.providerName.trim() : "";
  if (!providerName || !isValidProviderName(providerName)) {
    throw new Error("providerName is invalid");
  }
  return providerName;
}

/** What a check depends on; the key only as a fingerprint, never kept. */
function providerCheckKey(providerName: string, provider: Config["models"]["providers"][string]) {
  return [providerName, provider.type, provider.baseURL, provider.organizationId ?? "", keyFingerprint(provider.apiKey)].join("\0");
}

/** A key as a short fingerprint: what a cached answer was for, without the key. */
function keyFingerprint(apiKey: string): string {
  return apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 16) : "public";
}

function providerModelCacheKey(providerName: string, provider: Config["models"]["providers"][string]) {
  return [
    providerName,
    provider.type,
    provider.baseURL,
    // The key's fingerprint, not just "has one": a listing for an old key
    // landing after the key changed must not be served for the new one.
    keyFingerprint(provider.apiKey),
    // Kilo lists by organisation.
    provider.organizationId ?? "",
    provider.models
      .map((model) => `${model.id}:${model.input.join("+")}:${String(model.supportsReasoning)}`)
      .join(",")
  ].join("\0");
}
