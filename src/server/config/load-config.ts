import { resolveDataDir } from "../platform/fs/data-dir.js";
import { SETTINGS_NUMBER_LIMITS } from "../../shared/settings.js";
import {
  normalizeLogRequestsMode,
  normalizeOptionalString
} from "../modules/settings/config-schema.js";
import { createConfigStore } from "./config-store.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { isObject, mergeConfig } from "./json.js";
import type { Config, JsonObject as ConfigJsonObject, MemoryConfig } from "./types.js";
import { debugEnvEnabled, normalizeLogLevel, parseLogLevel } from "../platform/logger.js";
import {
  normalizeAgentModelConfig,
  normalizeModelsConfig,
  normalizeVoiceConfig
} from "./model-resolution.js";
import type { JsonStore } from "../platform/storage/json-store.js";
import { GLOBAL_AGENT_NAME_MAX, normalizeGlobalAgentName } from "../../shared/global-agent-name.js";
export type {
  AgentRoute,
  Config,
  JsonObject,
  ProviderConfig,
  ResolvedProviderConfig
} from "./types.js";
export { modelSupportsInput } from "./model-resolution.js";

export function loadConfig(
  dir = resolveDataDir(),
  configStore: JsonStore<ConfigJsonObject> = createConfigStore(dir)
): Config {
  const fileConfig = configStore.read();
  const fileAgent = isObject(fileConfig.agent) ? fileConfig.agent : {};
  const fileVoice = isObject(fileConfig.voice) ? fileConfig.voice : {};
  const merged = mergeConfig(DEFAULT_CONFIG, fileConfig);

  if (process.env.MANDATE_HOST) {
    merged.host = process.env.MANDATE_HOST;
  }
  if (process.env.PORT) {
    merged.port = Number(process.env.PORT);
  }
  // Only `false` in the file turns the check off; the environment has the last word.
  merged.checkOrigin = merged.checkOrigin !== false;
  if (process.env.MANDATE_CHECK_ORIGIN) {
    merged.checkOrigin = !/^(?:0|false|off|no)$/i.test(process.env.MANDATE_CHECK_ORIGIN.trim());
  }
  if (process.env.MANDATE_POLL_INTERVAL_MS) {
    merged.pollIntervalMs = Number(process.env.MANDATE_POLL_INTERVAL_MS);
  }
  if (process.env.MANDATE_CAPTURE_LINES) {
    merged.captureLines = Number(process.env.MANDATE_CAPTURE_LINES);
  }
  merged.logging = isObject(merged.logging) ? merged.logging as Config["logging"] : { ...DEFAULT_CONFIG.logging };
  merged.logging.level = normalizeLogLevel(merged.logging.level, DEFAULT_CONFIG.logging.level);
  if (process.env.MANDATE_LOG_LEVEL) {
    merged.logging.level = parseLogLevel(process.env.MANDATE_LOG_LEVEL) ?? DEFAULT_CONFIG.logging.level;
  } else if (debugEnvEnabled()) {
    merged.logging.level = "debug";
  }

  normalizeModelsConfig(merged);

  if (!Number.isFinite(merged.port)) {
    merged.port = DEFAULT_CONFIG.port;
  }
  if (!Number.isFinite(merged.pollIntervalMs) || merged.pollIntervalMs < 500) {
    merged.pollIntervalMs = DEFAULT_CONFIG.pollIntervalMs;
  }
  if (!Number.isFinite(merged.captureLines) || merged.captureLines < 20) {
    merged.captureLines = DEFAULT_CONFIG.captureLines;
  }

  normalizeAgentModelConfig(merged, fileAgent);
  merged.agent.preferences = normalizeOptionalString(merged.agent.preferences);

  if (process.env.MANDATE_AGENT_LOG_REQUESTS)
    merged.agent.logRequests = process.env.MANDATE_AGENT_LOG_REQUESTS;
  merged.agent.logRequests = normalizeLogRequestsMode(merged.agent.logRequests);
  // A hand-edited file may hold anything: one line, at most the limit.
  const rawName = merged.agent.globalAgentName;
  merged.agent.globalAgentName = normalizeGlobalAgentName(rawName)
    ?? String(rawName).replace(/\s+/g, " ").trim().slice(0, GLOBAL_AGENT_NAME_MAX);

  normalizeMemoryConfig(merged.memory);
  merged.retention = isObject(merged.retention)
    ? merged.retention as Config["retention"]
    : { ...DEFAULT_CONFIG.retention };
  normalizeRetentionConfig(merged.retention);

  if (process.env.MANDATE_VOICE_API_KEY) merged.voice.apiKey = process.env.MANDATE_VOICE_API_KEY;
  if (process.env.MANDATE_VOICE_PROVIDER)
    merged.voice.provider = process.env.MANDATE_VOICE_PROVIDER;
  if (process.env.MANDATE_VOICE_MODEL) merged.voice.model = process.env.MANDATE_VOICE_MODEL;
  if (process.env.MANDATE_VOICE_VOICE) merged.voice.voice = process.env.MANDATE_VOICE_VOICE;
  if (process.env.MANDATE_VOICE_LANGUAGE)
    merged.voice.language = process.env.MANDATE_VOICE_LANGUAGE;
  if (process.env.MANDATE_VOICE_BASE_URL) merged.voice.baseURL = process.env.MANDATE_VOICE_BASE_URL;
  if (process.env.MANDATE_VOICE_DEPLOYMENT)
    merged.voice.deployment = process.env.MANDATE_VOICE_DEPLOYMENT;
  if (process.env.MANDATE_VOICE_CONTEXT_MESSAGES) {
    merged.voice.contextMessageCount = Number(process.env.MANDATE_VOICE_CONTEXT_MESSAGES);
  }
  merged.webSearch = normalizeWebSearchConfig(merged.webSearch);
  normalizeVoiceConfig(merged, fileVoice);
  merged.voice.idleTimeoutMs = normalizeDurationMs(
    merged.voice.idleTimeoutMs,
    DEFAULT_CONFIG.voice.idleTimeoutMs
  );
  merged.voice.maxSessionMs = normalizeDurationMs(
    merged.voice.maxSessionMs,
    DEFAULT_CONFIG.voice.maxSessionMs
  );
  {
    const n = Number(merged.voice.contextMessageCount);
    if (!Number.isFinite(n) || n < 0) {
      merged.voice.contextMessageCount = DEFAULT_CONFIG.voice.contextMessageCount;
    } else {
      merged.voice.contextMessageCount = Math.min(
        Math.floor(n),
        SETTINGS_NUMBER_LIMITS.voice.contextMessageCount.max
      );
    }
  }

  return merged;
}

/** Floors, not just defaults. Every other numeric in this file is normalized so a
 *  bad value degrades behaviour; retention is the block where a bad value destroys
 *  data, unattended, every hour, and config.json is documented as hand-editable
 *  (README, "AI providers"). Each of these was reachable by a plausible edit:
 *
 *    chatToolResultHeadChars: 0   - every eligible tool result reduced to nothing
 *                                   but the marker. Irreversible.
 *    chatRetentionDays: 0         - every thread instantly past the window. The
 *                                   natural way to type "turn this off" was the
 *                                   single most destructive value in the file.
 *    chatToolResultHeadChars: "2000" (a string, from an editor that quotes
 *                                   numbers) - SQLite orders INTEGER below TEXT,
 *                                   so the length comparison was false for every
 *                                   row and the pass silently did nothing forever.
 *    chatRetentionDays: "abc"     - new Date(NaN).toISOString() throws, hourly,
 *                                   into the retention job's swallowing catch.
 *
 *  So each field is coerced to a finite number first -- which is what fixes both
 *  string cases -- and then rejected back to its default if it falls below a floor
 *  no real setting could be under. Rejected rather than clamped: a user who wrote
 *  0 meant something this feature cannot do, and the default is the only value
 *  that is certainly safe to do instead.
 *
 *  The floors: a head shorter than a couple of hundred characters cannot leave a
 *  usable trace of a tool result (the spool's file path alone is most of that
 *  budget), a retention window has to be at least a day to mean anything, and a
 *  ceiling under a megabyte is one every real database is permanently over, which
 *  silently converts the age-gated policy into "shorten everything". */
const RETENTION_FLOORS = {
  chatRetentionDays: 1,
  chatMaxTableBytes: 1024 * 1024,
  chatToolResultHeadChars: 200
} as const;

function normalizeRetentionConfig(retention: Config["retention"]) {
  for (const key of Object.keys(RETENTION_FLOORS) as Array<keyof typeof RETENTION_FLOORS>) {
    const n = Number(retention[key]);
    retention[key] = Number.isFinite(n) && n >= RETENTION_FLOORS[key]
      ? Math.floor(n)
      : DEFAULT_CONFIG.retention[key];
  }
}

function normalizeMemoryConfig(memory: MemoryConfig) {
  memory.embedding.model = normalizeOptionalString(memory.embedding.model);
  if (typeof memory.dream.enabled !== "boolean") {
    memory.dream.enabled = DEFAULT_CONFIG.memory.dream.enabled;
  }
}

function normalizeDurationMs(value: unknown, fallback: number) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    return fallback;
  }
  return Math.floor(Number(value));
}

/** The choice as a trimmed string ("off" when it is not one); each kind's
 *  values that are strings, kinds that are objects. */
function normalizeWebSearchConfig(value: unknown): Config["webSearch"] {
  const section = isObject(value) ? value : {};
  const use = typeof section.use === "string" && section.use.trim() ? section.use.trim() : "off";
  const kinds: Config["webSearch"]["kinds"] = {};
  if (isObject(section.kinds)) {
    for (const [id, values] of Object.entries(section.kinds)) {
      if (!isObject(values)) continue;
      kinds[id] = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  }
  return { use, kinds };
}
