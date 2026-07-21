import {
  SETTINGS_NUMBER_LIMITS,
  type LogRequestsMode,
  type SettingsConfigResponse,
  type SettingsConfigUpdate
} from "./types";

export type AgentsUnitForm = {
  preferences: string;
  compressionThresholdTokens: string;
  logRequests: LogRequestsMode;
};
export type WebAccessUnitForm = { host: string; port: string };

export function deriveAgentsUnit(config: SettingsConfigResponse): AgentsUnitForm {
  return {
    preferences: config.agent.preferences,
    compressionThresholdTokens: String(config.agent.compressionThresholdTokens),
    logRequests: config.agent.logRequests
  };
}

export function deriveWebAccessUnit(config: SettingsConfigResponse): WebAccessUnitForm {
  return {
    host: config.server.host,
    port: String(config.server.port)
  };
}

export function buildAgentsPatch(form: AgentsUnitForm): SettingsConfigUpdate {
  const error = compressionThresholdError(form.compressionThresholdTokens);
  if (error) throw new Error(error);
  return {
    agent: {
      preferences: form.preferences,
      compressionThresholdTokens: Number(form.compressionThresholdTokens.trim()),
      logRequests: form.logRequests
    }
  };
}

export function compressionThresholdError(raw: string): string {
  const text = raw.trim();
  const tokens = Number(text);
  const { min } = SETTINGS_NUMBER_LIMITS.agent.compressionThresholdTokens;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(tokens) || tokens < min) {
    return `Enter a whole number of at least ${min.toLocaleString("en-US")} tokens.`;
  }
  return "";
}

export function buildWebAccessPatch(form: WebAccessUnitForm): SettingsConfigUpdate {
  return {
    server: {
      host: normalizeHost(form.host),
      port: normalizePort(form.port)
    }
  };
}

function normalizeHost(raw: string): string {
  const host = raw.trim();
  if (!host) throw new Error("Listen address is required.");
  return host;
}

function normalizePort(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const port = Number(trimmed);
  const limits = SETTINGS_NUMBER_LIMITS.server.port;
  if (!Number.isInteger(port) || port < limits.min || port > limits.max) {
    throw new Error(`Port must be an integer between ${limits.min} and ${limits.max}.`);
  }
  return port;
}
