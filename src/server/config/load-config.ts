import { resolveDataDir } from "../platform/fs/data-dir.js";
import {
  normalizeLogRequestsMode,
  normalizeOptionalString
} from "../modules/settings/config-schema.js";
import { CONFIG_NOT_AN_OBJECT, configPath, createConfigStore } from "./config-store.js";
import { ConfigFileError, configFileProblems } from "./file-check.js";
import { flatFromFile } from "./file-layout.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { isObject, mergeConfig, withoutNulls } from "./json.js";
import type { Config, JsonObject as ConfigJsonObject, MemoryConfig } from "./types.js";
import { normalizeLogLevel } from "../platform/logger.js";
import { startOverrides } from "./start-overrides.js";
import {
  normalizeAgentModelConfig,
  normalizeModelsConfig,
  normalizeVoiceConfig
} from "./model-resolution.js";
import type { JsonStore } from "../platform/storage/json-store.js";
import { normalizeRuntimeConfig } from "./runtime-config.js";
import { normalizePersonalAgentName } from "../../shared/personal-agent-name.js";
export type {
  AgentRoute,
  NotificationChannelConfig,
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
  const file = configPath(dir);
  // The loader merges the app's flat keys (file-layout.ts).
  const fileConfig = flatFromFile(withoutNulls(readChecked(configStore, file)));
  const fileAgent = isObject(fileConfig.agent) ? fileConfig.agent : {};
  const fileVoice = isObject(fileConfig.voice) ? fileConfig.voice : {};
  const merged = mergeConfig(DEFAULT_CONFIG, fileConfig);

  merged.host = merged.host.trim();
  const flags = startOverrides();
  if (flags.host) merged.host = flags.host;
  if (flags.port !== undefined) merged.port = flags.port;
  merged.logging = isObject(merged.logging) ? merged.logging as Config["logging"] : { ...DEFAULT_CONFIG.logging };
  merged.logging.level = flags.logLevel ?? normalizeLogLevel(merged.logging.level, DEFAULT_CONFIG.logging.level);
  merged.logging.stacks = merged.logging.stacks === true;
  merged.logging.streamTrace = merged.logging.streamTrace !== false;
  // Only `false` in the file turns them off.
  merged.schedules = { enabled: !(isObject(fileConfig.schedules) && fileConfig.schedules.enabled === false) };
  const extraDirs = isObject(fileConfig.skills) && Array.isArray(fileConfig.skills.extraDirs) ? fileConfig.skills.extraDirs : [];
  merged.skills = { extraDirs: extraDirs.filter((dir): dir is string => typeof dir === "string").map((dir) => dir.trim()).filter(Boolean) };

  normalizeModelsConfig(merged);

  // A start override the CLI did not check (a test's): the default.
  if (!Number.isFinite(merged.port)) {
    merged.port = DEFAULT_CONFIG.port;
  }
  merged.runtime = normalizeRuntimeConfig(fileConfig.runtime);

  normalizeAgentModelConfig(merged, fileAgent);
  merged.agent.preferences = normalizeOptionalString(merged.agent.preferences);
  merged.agent.toolReviewRules = normalizeOptionalString(merged.agent.toolReviewRules);

  merged.agent.logRequests = normalizeLogRequestsMode(merged.agent.logRequests);
  // One line (the check has kept it within the limit).
  merged.agent.personalAgentName = normalizePersonalAgentName(merged.agent.personalAgentName) ?? "";

  normalizeMemoryConfig(merged.memory);

  merged.webSearch = normalizeWebSearchConfig(merged.webSearch);
  merged.notifications = normalizeNotificationsConfig(merged.notifications);
  normalizeVoiceConfig(merged, fileVoice);

  return merged;
}

/** The file's contents, refused with its problems when the server cannot
 *  use them as written. */
function readChecked(configStore: JsonStore<ConfigJsonObject>, file: string): ConfigJsonObject {
  let raw: ConfigJsonObject;
  try {
    raw = configStore.read();
  } catch (error) {
    if (error instanceof SyntaxError) throw ConfigFileError.syntax(file, error.message);
    if (error instanceof Error && error.message === CONFIG_NOT_AN_OBJECT) throw ConfigFileError.notAnObject(file);
    throw error;
  }
  const problems = configFileProblems(raw);
  if (problems.length > 0) throw ConfigFileError.invalid(file, problems);
  return raw;
}

function normalizeMemoryConfig(memory: MemoryConfig) {
  memory.embedding.model = normalizeOptionalString(memory.embedding.model);
  if (typeof memory.dream.enabled !== "boolean") {
    memory.dream.enabled = DEFAULT_CONFIG.memory.dream.enabled;
  }
}

/** As the file has it, kept to the shape: a channel needs an id and a kind;
 *  values that are not strings go. */
function normalizeNotificationsConfig(value: unknown): Config["notifications"] {
  const section = isObject(value) ? value : {};
  const defaults = DEFAULT_CONFIG.notifications;
  const text = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : fallback);
  const channels: Config["notifications"]["channels"] = [];
  for (const raw of Array.isArray(section.channels) ? section.channels : []) {
    if (!isObject(raw)) continue;
    const id = text(raw.id, "");
    const kind = text(raw.kind, "");
    if (!id || !kind) continue;
    const values = isObject(raw.values)
      ? Object.fromEntries(Object.entries(raw.values).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    channels.push({ id, kind, name: text(raw.name, "") || kind, enabled: raw.enabled !== false, includeText: raw.includeText !== false, values });
  }
  return {
    linkBase: text(section.linkBase, defaults.linkBase),
    desktopApp: section.desktopApp === true,
    telegramApiBase: text(section.telegramApiBase, "") || defaults.telegramApiBase,
    channels
  };
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
