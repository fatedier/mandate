import { z } from "zod";
import { PERSONAL_AGENT_NAME_MAX, normalizePersonalAgentName } from "../../shared/personal-agent-name.js";
import {
  LOG_REQUEST_MODE_VALUES,
  MODEL_INPUT_TYPE_VALUES,
  MODEL_PROTOCOL_VALUES,
  PROVIDER_BILLING_VALUES,
  PROVIDER_TYPE_VALUES,
  REASONING_EFFORT_VALUES,
  SERVICE_TIER_VALUES,
  SETTINGS_NUMBER_LIMITS,
  parseModelPriceSetting
} from "../../shared/settings.js";
import { isValidProviderName } from "../modules/settings/config-normalizers.js";
import { LOG_LEVELS } from "../platform/logger.js";
import { AGENT_ROUTES } from "./model-resolution.js";
import { RUNTIME_PACES } from "./runtime-config.js";

/**
 * Every value config.json can hold, checked as the loader reads it: a value
 * it cannot use as written is a problem line naming the key, the rule and
 * what was given. Only checked: the loader still fills defaults and
 * normalizes. Key names are not checked (an unknown key is ignored), `null`
 * is a key left out, and options are read trimmed and in any case where the
 * loader reads them so. A free-text value is never shown: it may be a key.
 */

/** The floors the loader has always kept for the poller. */
export const POLL_FLOORS = { pollIntervalMs: 500, captureLines: 20 } as const;

/** Retention's floors. Retention is where a bad value destroys data,
 *  unattended, every hour, and each of these was reachable by a plausible
 *  edit: `chatToolResultHeadChars: 0` cut every eligible tool result to the
 *  marker; `chatRetentionDays: 0`, the natural way to type "off", put every
 *  thread past the window; `"2000"` as a string made SQLite's length
 *  comparison false for every row, so the pass did nothing; `"abc"` threw
 *  hourly. A head under a couple of hundred characters leaves no usable
 *  trace (the spool's file path is most of it), a window under a day means
 *  nothing, and a ceiling under a megabyte is one every database is over for
 *  good ("shorten everything"). Below them, the server does not start. */
export const RETENTION_FLOORS = {
  chatRetentionDays: 1,
  chatMaxTableBytes: SETTINGS_NUMBER_LIMITS.retention.chatMaxTableBytes.min,
  chatToolResultHeadChars: 200
} as const;

/** The longest a timer waits: given more, it fires at once. */
export const TIMER_MAX_MS = 2_147_483_647;

const SHOWN_MAX = 40;

function cut(text: string): string {
  return text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX)}…` : text;
}

/** What was given, for the line: where `show`, a text, number or true/false
 *  itself; else, and always for a list or an object (which may hold a
 *  secret), its kind. A key left out is missing; null shows only as an item
 *  of a list (a key set to null is one left out). */
function given(input: unknown, show: boolean): string {
  if (input === undefined) return "missing";
  if (input === null) return "null";
  if (input === "") return "empty";
  if (typeof input === "string") return show ? cut(JSON.stringify(input)) : "text";
  if (typeof input === "number") return show ? cut(String(input)) : "a number";
  if (typeof input === "boolean") return show ? String(input) : "true or false";
  if (Array.isArray(input)) return "a list";
  if (typeof input === "object") return "an object";
  return typeof input;
}

const says = (rule: string, show: boolean) => (issue: { input?: unknown }) => `${rule} (it is ${given(issue.input, show)})`;

/** A key the file may leave out or set to null. */
function opt<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema.optional());
}

/** A key the file must give (null is leaving it out). */
function req<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema);
}

function whole(min: number, max?: number) {
  const error = says(max === undefined ? `must be a whole number of at least ${min}` : `must be a whole number from ${min} to ${max}`, true);
  const base = z.number({ error }).int({ error }).min(min, { error });
  return max === undefined ? base : base.max(max, { error });
}

function bool() {
  return z.boolean({ error: says("must be true or false", true) });
}

function text() {
  return z.string({ error: says("must be text", false) });
}

function filled(rule = "must be text, not empty") {
  const error = says(rule, false);
  return z.string({ error }).refine((value) => value.trim() !== "", { error });
}

/** One of `values`: trimmed and in any case where the loader reads it so,
 *  else exactly. */
function oneOf(values: readonly string[], { exact = false, rule }: { exact?: boolean; rule?: string } = {}) {
  const error = says(rule ?? `must be one of ${values.map((value) => (value === "" ? '""' : value)).join(", ")}`, true);
  return z.string({ error }).refine((value) => values.includes(exact ? value : value.trim().toLowerCase()), { error });
}

function section<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape, { error: says("must be an object", false) });
}

function list<T extends z.ZodType>(item: T, rule = "must be a list") {
  return z.array(item, { error: says(rule, false) });
}

function textValues() {
  return z.record(z.string(), opt(text()), { error: says("must be an object", false) });
}

/** `provider/model` as the loader reads it, or "" (not set). */
function modelRef() {
  const error = says("must be provider/model", true);
  return z.string({ error }).refine((value) => {
    const raw = value.trim();
    if (!raw) return true;
    const slash = raw.indexOf("/");
    return slash > 0 && isValidProviderName(raw.slice(0, slash).trim()) && raw.slice(slash + 1).trim() !== "";
  }, { error });
}

const effort = () => oneOf(REASONING_EFFORT_VALUES);

/** A fallback model of a route. */
function fallback() {
  return section({ model: opt(modelRef()), reasoningEffort: opt(effort()), serviceTier: opt(oneOf(SERVICE_TIER_VALUES)) });
}

/** A model route as the file groups it (file-layout.ts): its model, effort
 *  and fallbacks, and what else its group holds. */
function route<T extends z.ZodRawShape>(extra: T = {} as T) {
  return section({ ...extra, model: opt(modelRef()), reasoningEffort: opt(effort()), serviceTier: opt(oneOf(SERVICE_TIER_VALUES)), fallbacks: opt(list(fallback())) });
}

const PRICE_RULE = 'must be { as: "litellm:<model>" } or { as: "models.dev:<provider>/<model>" } or input and output prices, each a number of USD per 1M tokens, 0 or more';

const providerModel = section({
  id: req(filled()),
  input: opt(list(oneOf(MODEL_INPUT_TYPE_VALUES))),
  supportsReasoning: opt(bool()),
  protocol: opt(oneOf(MODEL_PROTOCOL_VALUES, { exact: true })),
  kind: opt(oneOf(["decision"], { exact: true, rule: 'must be "decision"' })),
  price: opt(z.unknown().refine((value) => parseModelPriceSetting(value).ok, { error: says(PRICE_RULE, true) })),
  cacheLifetimeMinutes: opt(whole(SETTINGS_NUMBER_LIMITS.models.cacheLifetimeMinutes.min, SETTINGS_NUMBER_LIMITS.models.cacheLifetimeMinutes.max))
});

const provider = section({
  type: req(oneOf(PROVIDER_TYPE_VALUES)),
  baseURL: opt(text()),
  organizationId: opt(text()),
  apiKey: opt(text()),
  serviceTier: opt(oneOf(SERVICE_TIER_VALUES)),
  billing: opt(oneOf(PROVIDER_BILLING_VALUES, { exact: true })),
  models: opt(list(providerModel).superRefine((models, ctx) => {
    // It runs even when the value is no list at all (see `when`).
    if (!Array.isArray(models)) return;
    const seen = new Set<string>();
    models.forEach((model, index) => {
      const id = typeof model?.id === "string" ? model.id.trim() : "";
      if (!id) return;
      if (seen.has(id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "is the same as an earlier model's" });
      seen.add(id);
    });
  // Also when an entry has a problem of its own: each is reported.
  }, { when: () => true }))
});

const agentLimits = SETTINGS_NUMBER_LIMITS.agent;
const check = () => route({ enabled: opt(bool()) });

const agent = section({
  preferences: opt(text()),
  routes: opt(section(Object.fromEntries(AGENT_ROUTES.map((name) => [name, opt(route())])))),
  decisions: opt(check()),
  checks: opt(section({ managerRequest: opt(check()), managerStop: opt(check()), memoryRepeat: opt(check()) })),
  toolReview: opt(section({ enabled: opt(bool()), rules: opt(text()), screen: opt(route()), secondLook: opt(route()) })),
  compaction: opt(section({
    thresholdTokens: opt(whole(agentLimits.compressionThresholdTokens.min)),
    idle: opt(section({
      enabled: opt(bool()),
      leadMinutes: opt(whole(agentLimits.idleCompactionLeadMinutes.min, agentLimits.idleCompactionLeadMinutes.max)),
      minTokens: opt(whole(agentLimits.idleCompactionMinTokens.min))
    }))
  })),
  logRequests: opt(oneOf(LOG_REQUEST_MODE_VALUES)),
  personalAgentName: opt(text().refine((name) => normalizePersonalAgentName(name) !== null, {
    error: says(`must be text of at most ${PERSONAL_AGENT_NAME_MAX} characters`, false)
  }))
});

const runtime = section(Object.fromEntries(
  Object.entries(RUNTIME_PACES).map(([key, pace]) => [key, opt(whole(pace.floor, TIMER_MAX_MS))])
));

const voiceLimits = SETTINGS_NUMBER_LIMITS.voice;

const FILE = section({
  server: opt(section({
    port: opt(whole(SETTINGS_NUMBER_LIMITS.server.port.min, SETTINGS_NUMBER_LIMITS.server.port.max)),
    host: opt(filled("must be a listen address")),
    checkOrigin: opt(bool())
  })),
  panes: opt(section({
    pollIntervalMs: opt(whole(POLL_FLOORS.pollIntervalMs, TIMER_MAX_MS)),
    captureLines: opt(whole(POLL_FLOORS.captureLines))
  })),
  runtime: opt(runtime),
  logging: opt(section({ level: opt(oneOf(LOG_LEVELS)), stacks: opt(bool()), streamTrace: opt(bool()) })),
  schedules: opt(section({ enabled: opt(bool()) })),
  skills: opt(section({ extraDirs: opt(list(filled("must be a folder path"), "must be a list of folder paths")) })),
  models: opt(section({
    default: opt(section({ model: opt(modelRef()), reasoningEffort: opt(effort()), serviceTier: opt(oneOf(SERVICE_TIER_VALUES)), fallbacks: opt(list(fallback())) })),
    providers: opt(z.record(z.string().refine(isValidProviderName), opt(provider), {
      // A key that fails is reported by the record: it names the key.
      error: (issue) => issue.code === "invalid_key"
        ? 'is not a provider name (letters, digits, ".", "_" and "-")'
        : says("must be an object", false)(issue)
    })),
    prices: opt(section({ autoUpdate: opt(bool()) }))
  })),
  agent: opt(agent),
  memory: opt(section({
    embedding: opt(section({ model: opt(text()) })),
    dream: opt(section({ enabled: opt(bool()) }))
  })),
  retention: opt(section({
    chatRetentionDays: opt(whole(RETENTION_FLOORS.chatRetentionDays)),
    chatMaxTableBytes: opt(whole(RETENTION_FLOORS.chatMaxTableBytes)),
    chatToolResultHeadChars: opt(whole(RETENTION_FLOORS.chatToolResultHeadChars))
  })),
  webSearch: opt(section({
    use: opt(text()),
    kinds: opt(z.record(z.string(), opt(textValues()), { error: says("must be an object", false) }))
  })),
  notifications: opt(section({
    linkBase: opt(text()),
    desktopApp: opt(bool()),
    telegramApiBase: opt(text()),
    channels: opt(list(section({
      id: req(filled()),
      kind: req(filled()),
      name: opt(text()),
      enabled: opt(bool()),
      includeText: opt(bool()),
      values: opt(textValues())
    })))
  })),
  voice: opt(section({
    provider: opt(text()),
    apiKey: opt(text()),
    model: opt(text()),
    voice: opt(text()),
    language: opt(text()),
    idleTimeoutMs: opt(whole(voiceLimits.idleTimeoutMs.min, TIMER_MAX_MS)),
    maxSessionMs: opt(whole(voiceLimits.maxSessionMs.min, TIMER_MAX_MS)),
    contextMessageCount: opt(whole(voiceLimits.contextMessageCount.min, voiceLimits.contextMessageCount.max)),
    baseURL: opt(text()),
    deployment: opt(text())
  }))
});

/** `models.providers["my proxy"].models[2].id`. */
function pathOf(path: ReadonlyArray<PropertyKey>): string {
  return path.map((segment, index) => {
    if (typeof segment === "number") return `[${segment}]`;
    const key = String(segment);
    if (/^[A-Za-z0-9_-]+$/.test(key)) return index === 0 ? key : `.${key}`;
    return `[${JSON.stringify(key)}]`;
  }).join("");
}

/** The problem lines for a config.json's contents, in the file's own order of
 *  sections; none for a file the server can use as written. */
export function configFileProblems(raw: unknown): string[] {
  const result = FILE.safeParse(raw);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const at = pathOf(issue.path);
    return at ? `${at}: ${issue.message}` : issue.message;
  });
}

/** A config.json the server will not start on, and why. */
export class ConfigFileError extends Error {
  private constructor(message: string, readonly file: string, readonly problems: string[]) {
    super(message);
    this.name = "ConfigFileError";
  }

  static invalid(file: string, problems: string[]): ConfigFileError {
    const count = problems.length === 1 ? "1 error" : `${problems.length} errors`;
    return new ConfigFileError(`${file} has ${count}:\n${problems.map((line) => `  ${line}`).join("\n")}`, file, problems);
  }

  static notAnObject(file: string): ConfigFileError {
    return new ConfigFileError(`${file} must hold a JSON object`, file, []);
  }

  static syntax(file: string, reason: string): ConfigFileError {
    // Bun's reason opens with what the line already says.
    return new ConfigFileError(`${file} is not valid JSON: ${reason.replace(/^JSON Parse error: /, "")}`, file, []);
  }
}
