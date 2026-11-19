import {
  DEFAULT_CHAT_MAX_TABLE_BYTES,
  SETTINGS_NUMBER_LIMITS,
  type LogRequestsMode,
  type SettingsConfigResponse,
  type SettingsConfigUpdate
} from "@shared/settings";

type AgentsUnitForm = {
  preferences: string;
  compressionThresholdTokens: string;
  logRequests: LogRequestsMode;
  /** Idle compaction: on, minutes before the cache expires, smallest context. */
  idleCompactionEnabled: boolean;
  idleCompactionLeadMinutes: string;
  idleCompactionMinTokens: string;
  /** The tool-call review: on, and the user's rules for it. */
  toolReviewEnabled: boolean;
  toolReviewRules: string;
};
type WebAccessUnitForm = { host: string; port: string };

export function deriveAgentsUnit(config: SettingsConfigResponse): AgentsUnitForm {
  return {
    preferences: config.agent.preferences,
    compressionThresholdTokens: String(config.agent.compressionThresholdTokens),
    logRequests: config.agent.logRequests,
    idleCompactionEnabled: config.agent.idleCompactionEnabled,
    idleCompactionLeadMinutes: String(config.agent.idleCompactionLeadMinutes),
    idleCompactionMinTokens: config.agent.idleCompactionMinTokens.toLocaleString("en-US"),
    toolReviewEnabled: config.agent.toolReviewEnabled,
    toolReviewRules: config.agent.toolReviewRules
  };
}

export function deriveWebAccessUnit(config: SettingsConfigResponse): WebAccessUnitForm {
  return {
    host: config.server.host,
    port: String(config.server.port)
  };
}

export function buildAgentsPatch(form: AgentsUnitForm): SettingsConfigUpdate {
  const idle = idleFieldErrors(form);
  const error = compressionThresholdError(form.compressionThresholdTokens) || idle.lead || idle.minTokens;
  if (error) throw new Error(error);
  return {
    agent: {
      preferences: form.preferences,
      compressionThresholdTokens: Number(tokenDigits(form.compressionThresholdTokens)),
      logRequests: form.logRequests,
      idleCompactionEnabled: form.idleCompactionEnabled,
      // Switched off, a hidden value it would refuse is not sent: the saved one stays.
      ...(idleLeadError(form.idleCompactionLeadMinutes) ? {} : { idleCompactionLeadMinutes: Number(form.idleCompactionLeadMinutes.trim()) }),
      ...(idleMinTokensError(form.idleCompactionMinTokens) ? {} : { idleCompactionMinTokens: Number(tokenDigits(form.idleCompactionMinTokens)) }),
      toolReviewEnabled: form.toolReviewEnabled,
      toolReviewRules: form.toolReviewRules
    }
  };
}

/** Why the idle compaction fields are refused; nothing while switched off,
 *  when they are hidden. */
export function idleFieldErrors(form: Pick<AgentsUnitForm, "idleCompactionEnabled" | "idleCompactionLeadMinutes" | "idleCompactionMinTokens">): { lead: string; minTokens: string } {
  if (!form.idleCompactionEnabled) return { lead: "", minTokens: "" };
  return { lead: idleLeadError(form.idleCompactionLeadMinutes), minTokens: idleMinTokensError(form.idleCompactionMinTokens) };
}

/** Idle compaction's minutes before the cache expires: whole, 1 to 59. */
export function idleLeadError(raw: string): string {
  const text = raw.trim();
  const { min, max } = SETTINGS_NUMBER_LIMITS.agent.idleCompactionLeadMinutes;
  const minutes = Number(text);
  return /^\d+$/.test(text) && minutes >= min && minutes <= max ? "" : `Enter whole minutes from ${min} to ${max}.`;
}

/** Idle compaction's smallest context, in the threshold's words. */
export function idleMinTokensError(raw: string): string {
  const text = tokenDigits(raw);
  const tokens = Number(text);
  const { min } = SETTINGS_NUMBER_LIMITS.agent.idleCompactionMinTokens;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(tokens) || tokens < min) {
    return `Enter a whole number of at least ${min.toLocaleString("en-US")} tokens.`;
  }
  return "";
}

/** A token count as typed: the field shows "200,000", so it takes one back
 *  with its separators. */
export function tokenDigits(raw: string): string {
  return raw.trim().replace(/,/g, "");
}

export function compressionThresholdError(raw: string): string {
  const text = tokenDigits(raw);
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

const GB = 1024 * 1024 * 1024;
/** The smallest limit the field takes: a real chat history is far past it, so
 *  anything smaller would shorten every tool output there is. */
const CHAT_LIMIT_MIN_GB = 0.01;

/** A byte count as the field shows it: GB, at most two decimals. */
export function chatLimitGb(bytes: number): string {
  return String(Math.round((bytes / GB) * 100) / 100);
}

export const DEFAULT_CHAT_LIMIT_GB = chatLimitGb(DEFAULT_CHAT_MAX_TABLE_BYTES);

/** Why the field's text is refused, or "". */
export function chatLimitError(raw: string): string {
  const gb = Number(raw.trim());
  return raw.trim() === "" || !Number.isFinite(gb) || gb < CHAT_LIMIT_MIN_GB ? `Enter a size of at least ${CHAT_LIMIT_MIN_GB} GB.` : "";
}

type StorageUnitForm = { chatLimitGb: string };

export function deriveStorageUnit(config: SettingsConfigResponse): StorageUnitForm {
  return { chatLimitGb: chatLimitGb(config.retention.chatMaxTableBytes) };
}

export function buildStoragePatch(form: StorageUnitForm): SettingsConfigUpdate {
  return { retention: { chatMaxTableBytes: Math.round(Number(form.chatLimitGb.trim()) * GB) } };
}
