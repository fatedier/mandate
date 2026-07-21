import type { SetupStatusResponse } from "../../../shared/api-contracts.js";
import type { Config } from "../../config.js";

export interface BuildSetupStatusOptions {
  config: Config;
  configFileExists?: boolean;
  projectCount: number;
  tmuxAvailable: boolean;
  tmuxError?: string | null;
  codexAuthenticated?: (providerName: string) => boolean;
}

export function buildSetupStatus({
  config,
  configFileExists = true,
  projectCount,
  tmuxAvailable,
  tmuxError = null,
  codexAuthenticated = () => false
}: BuildSetupStatusOptions): SetupStatusResponse {
  const defaultModelReady = modelRefReady(config, config.models.default.model, codexAuthenticated);
  const managerModelReady = resolvedModelReady(config.agent.manager, codexAuthenticated);
  const workerModelReady = resolvedModelReady(config.agent.worker, codexAuthenticated);

  const modelsReady =
    Object.keys(config.models.providers).length > 0 &&
    defaultModelReady &&
    managerModelReady &&
    workerModelReady;

  return {
    ok: true,
    firstRun: !configFileExists,
    ready: modelsReady && tmuxAvailable && projectCount > 0,
    models: {
      providerCount: Object.keys(config.models.providers).length,
      defaultModel: config.models.default.model,
      defaultModelReady,
      managerModelReady,
      workerModelReady,
      ready: modelsReady
    },
    terminal: {
      tmuxAvailable,
      error: tmuxError,
      ready: tmuxAvailable
    },
    projects: {
      count: projectCount,
      ready: projectCount > 0
    },
    agent: {
      preferencesReady: Boolean(config.agent.preferences.trim())
    }
  };
}

function modelRefReady(
  config: Config,
  modelRef: string,
  codexAuthenticated: (providerName: string) => boolean
): boolean {
  const slash = modelRef.indexOf("/");
  if (slash <= 0) return false;
  const providerName = modelRef.slice(0, slash).trim();
  const model = modelRef.slice(slash + 1).trim();
  if (!providerName || !model) return false;
  const provider = config.models.providers[providerName];
  if (!provider) return false;
  if (provider.type === "codex") return codexAuthenticated(providerName);
  return Boolean(provider.apiKey);
}

function resolvedModelReady(
  resolved: {
    providerName: string;
    model: string;
    providerType: string;
    apiKey: string;
  },
  codexAuthenticated: (providerName: string) => boolean
): boolean {
  if (!resolved.providerName || !resolved.model) return false;
  if (resolved.providerType === "codex") return codexAuthenticated(resolved.providerName);
  return Boolean(resolved.apiKey);
}
