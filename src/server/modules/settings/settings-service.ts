import {
  deleteCodexAuthProfile,
  getCodexAuthStatus,
  renameCodexAuthProfile,
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

interface SettingsServiceDeps {
  opener?: ExternalOpener;
  configStore?: JsonStore<JsonObject>;
  codexAuthStore?: CodexAuthStorage;
  httpClient?: HttpClient;
  reloadConfig?: () => Config;
}

export class SettingsService {
  private providerModelCache = new Map<string, { createdAt: number; result: ProviderModelsResult }>();

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
    writeSettingsConfig(payload, configStore, this.deps.codexAuthStore);
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

    const result = await fetchProviderModels(provider, { httpClient: this.deps.httpClient });
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
}

function restartRequiredForConfigChange(before: Config, after: Config): boolean {
  return before.host !== after.host
    || before.port !== after.port;
}

function writeSettingsConfig(
  payload: unknown,
  configStore: JsonStore<JsonObject>,
  codexAuthStore?: CodexAuthStorage
) {
  const current = configStore.read();
  const { next, authRenames } = applySettingsConfigPatch(current, payload);

  configStore.write(next);
  for (const rename of authRenames) {
    renameCodexAuthProfile(rename.from, rename.to, codexAuthStore ?? undefined);
  }
}

function providerNameFromPayload(payload: unknown) {
  if (!isJsonObject(payload)) throw new Error("payload must be an object");
  const providerName = typeof payload.providerName === "string" ? payload.providerName.trim() : "";
  if (!providerName || !isValidProviderName(providerName)) {
    throw new Error("providerName is invalid");
  }
  return providerName;
}

function providerModelCacheKey(providerName: string, provider: Config["models"]["providers"][string]) {
  return [
    providerName,
    provider.type,
    provider.baseURL,
    provider.apiKey ? "keyed" : "public",
    provider.models
      .map((model) => `${model.id}:${model.input.join("+")}:${String(model.supportsReasoning)}`)
      .join(",")
  ].join("\0");
}
