import type { LlmApi } from "../../shared/llm-api.js";
import { kiloModelApi } from "./kilo-model-apis.js";
import { isObject } from "./json.js";
import {
  MODEL_INPUT_TYPES,
  PROVIDER_DEFAULTS,
  VOICE_PROVIDER_TYPES as SUPPORTED_VOICE_PROVIDER_TYPES,
  isValidProviderName,
  normalizeOptionalString,
  normalizeProviderName,
  normalizeProviderType,
  normalizeReasoningEffort,
  normalizeServiceTier
} from "../modules/settings/config-schema.js";
import { DEFAULT_CODEX_REALTIME_MODEL, DEFAULT_CONFIG } from "./defaults.js";
import type {
  AgentRoute,
  Config,
  JsonObject,
  ModelCapabilityConfig,
  ModelInputType,
  ProviderConfig,
  ResolvedProviderConfig
} from "./types.js";
import { DEFAULT_MODEL_INPUTS, PROVIDER_BILLING_VALUES, parseModelPriceSetting, stepTakesServiceTier, type AgentModelSelection, type ModelProtocol, type ServiceTier } from "../../shared/settings.js";
import type { ProviderBilling } from "../../shared/api/pricing.js";

export function normalizeModelsConfig(config: Config) {
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, rawConfig] of Object.entries(config.models.providers ?? {})) {
    if (!isValidProviderName(name)) continue;
    const type = normalizeProviderType(rawConfig.type);
    if (!type) continue;
    const defaults = PROVIDER_DEFAULTS[type] ?? { baseURL: "" };
    providers[name] = {
      type,
      baseURL: normalizeOptionalString(rawConfig.baseURL) || defaults.baseURL,
      apiKey: providerApiKey(type, rawConfig.apiKey),
      models: normalizeModelCapabilities(rawConfig.models, type),
      ...(type === "kilo"
        ? { organizationId: normalizeOptionalString(rawConfig.organizationId) }
        : {}),
      ...(type === "codex" ? { serviceTier: normalizeServiceTier(rawConfig.serviceTier) } : {}),
      ...billingOf(rawConfig.billing)
    };
  }
  config.models.providers = providers;
  const rawPrices = (config.models as { prices?: unknown }).prices;
  config.models.prices = { autoUpdate: !(rawPrices && typeof rawPrices === "object" && (rawPrices as { autoUpdate?: unknown }).autoUpdate === false) };
  config.models.default.model = normalizeModelRef(config.models.default.model, "");
  config.models.default.reasoningEffort = normalizeReasoningEffort(
    config.models.default.reasoningEffort
  );
  const defaultTier = normalizeServiceTier(config.models.default.serviceTier);
  if (defaultTier) config.models.default.serviceTier = defaultTier;
  else delete config.models.default.serviceTier;
  config.models.default.modelFallbacks = normalizeAgentModelSelectionList(
    config.models.default.modelFallbacks,
    config.models.default.model
  ).filter((selection) => selection.model !== config.models.default.model);
}

export const AGENT_ROUTES: readonly AgentRoute[] = ["worker", "manager", "personal", "dream", "extraction", "subagent", "page", "skillReview"];

export function normalizeAgentModelConfig(config: Config, fileAgent: JsonObject = {}) {
  const defaultSelection: AgentModelSelection = {
    model: config.models.default.model,
    reasoningEffort: config.models.default.reasoningEffort,
    ...tierField(config.models.default.serviceTier)
  };
  for (const route of AGENT_ROUTES) resolveAgentRoute(config, fileAgent, route, defaultSelection);
  // Unset, the subagent route is not the default's: a subagent runs on the
  // route of the agent that started it. Whether the file sets it is kept,
  // from the file alone; a flag a hand edit wrote there decides nothing.
  config.agent.subagentRouteSet =
    hasExplicitAgentSelection(fileAgent, "subagentModel") ||
    hasExplicitAgentSelection(fileAgent, "subagentModelFallbacks");
  // The page updates' route, likewise: unset, a page subagent runs as subagents do.
  config.agent.pageRouteSet =
    hasExplicitAgentSelection(fileAgent, "pageModel") ||
    hasExplicitAgentSelection(fileAgent, "pageModelFallbacks");
  // The skill review's route: unset, whatever the Dream runs on (its own
  // route, or the default's), as Routing says.
  config.agent.skillReviewRouteSet =
    hasExplicitAgentSelection(fileAgent, "skillReviewModel") ||
    hasExplicitAgentSelection(fileAgent, "skillReviewModelFallbacks");
  if (!config.agent.skillReviewRouteSet) {
    config.agent.skillReview = config.agent.dream;
    config.agent.skillReviewModel = config.agent.dreamModel;
    config.agent.skillReviewModelFallbacks = config.agent.dreamModelFallbacks;
    config.agent.skillReviewFallbacks = config.agent.dreamFallbacks;
  }
  for (const route of JUDGEMENT_ROUTES) resolveJudgementRoute(config, fileAgent, route);
  config.agent.managerRequestCheckRouteSet =
    hasExplicitAgentSelection(fileAgent, "managerRequestCheckModel") ||
    hasExplicitAgentSelection(fileAgent, "managerRequestCheckModelFallbacks");
  config.agent.managerStopCheckRouteSet =
    hasExplicitAgentSelection(fileAgent, "managerStopCheckModel") ||
    hasExplicitAgentSelection(fileAgent, "managerStopCheckModelFallbacks");
  config.agent.memoryRepeatCheckRouteSet =
    hasExplicitAgentSelection(fileAgent, "memoryRepeatCheckModel") ||
    hasExplicitAgentSelection(fileAgent, "memoryRepeatCheckModelFallbacks");
  config.agent.toolReviewScreenRouteSet =
    hasExplicitAgentSelection(fileAgent, "toolReviewScreenModel") ||
    hasExplicitAgentSelection(fileAgent, "toolReviewScreenModelFallbacks");
  config.agent.toolReviewSecondLookRouteSet =
    hasExplicitAgentSelection(fileAgent, "toolReviewSecondLookModel") ||
    hasExplicitAgentSelection(fileAgent, "toolReviewSecondLookModelFallbacks");
  // The uses' On switches and idle compaction's numbers are the file's, or
  // the defaults (defaults.ts), as the check let them through.
}

export const JUDGEMENT_ROUTES = ["decisions", "managerRequestCheck", "managerStopCheck", "memoryRepeatCheck", "toolReviewScreen", "toolReviewSecondLook"] as const;

/** A judgement route: its own model and fallbacks where the file sets them,
 *  else nothing at all — unlike an agent route, never the default's. */
function resolveJudgementRoute(
  config: Config,
  fileAgent: JsonObject,
  route: (typeof JUDGEMENT_ROUTES)[number]
) {
  const modelKey = `${route}Model` as const;
  const fallbacksKey = `${route}ModelFallbacks` as const;
  const selection = hasExplicitAgentSelection(fileAgent, modelKey)
    ? normalizeAgentModelSelection(config.agent[modelKey], "")
    : { model: "", reasoningEffort: "provider-default" as const };
  const resolved = resolveModelSelection(config, selection);
  config.agent[route] = resolved;
  config.agent[modelKey] = { model: resolved.modelRef, reasoningEffort: resolved.reasoningEffort, ...tierField(selection.serviceTier) };
  const fallbacks = hasExplicitAgentSelection(fileAgent, fallbacksKey)
    ? normalizeAgentModelSelectionList(config.agent[fallbacksKey], resolved.modelRef)
      .filter((fallback) => fallback.model !== resolved.modelRef)
    : [];
  config.agent[fallbacksKey] = fallbacks;
  config.agent[`${route}Fallbacks` as const] = resolvedFallbackProviders(config, fallbacks);
}

/** The models a use of Decisions asks, in order, while it is on: its own
 *  route while that is set, else Decisions' while Decisions is on; none, it
 *  is off. */
function judgementUseChain(config: Config, use: "managerRequestCheck" | "managerStopCheck" | "memoryRepeatCheck"): ResolvedProviderConfig[] {
  const agent = config.agent;
  if (!agent[`${use}Enabled`]) return [];
  const chain = agent[`${use}RouteSet`]
    ? [agent[use], ...agent[`${use}Fallbacks`]]
    : agent.decisionsEnabled ? [agent.decisions, ...agent.decisionsFallbacks] : [];
  return chain.filter((step) => step.provider && step.model);
}

/** The models manager request check asks: on unless switched off. */
export function managerRequestCheckChain(config: Config): ResolvedProviderConfig[] {
  return judgementUseChain(config, "managerRequestCheck");
}

/** The models manager stop check asks: off until switched on. */
export function managerStopCheckChain(config: Config): ResolvedProviderConfig[] {
  return judgementUseChain(config, "managerStopCheck");
}

/** The models memory repeat check asks: off until switched on. */
export function memoryRepeatCheckChain(config: Config): ResolvedProviderConfig[] {
  return judgementUseChain(config, "memoryRepeatCheck");
}

/** A tool-call review stage's models: its own route while set, else
 *  Decisions' while Decisions is on; none otherwise. Whether the review is on
 *  is the caller's to ask: the chains also tell whether it can be. */
function toolReviewChain(config: Config, stage: "toolReviewScreen" | "toolReviewSecondLook"): ResolvedProviderConfig[] {
  const agent = config.agent;
  const chain = agent[`${stage}RouteSet`]
    ? [agent[stage], ...agent[`${stage}Fallbacks`]]
    : agent.decisionsEnabled ? [agent.decisions, ...agent.decisionsFallbacks] : [];
  return chain.filter((step) => step.provider && step.model);
}

/** The models the review's screen asks: decision and chat models alike. */
export function toolReviewScreenChain(config: Config): ResolvedProviderConfig[] {
  return toolReviewChain(config, "toolReviewScreen");
}

/** The models the review's second look asks: the chat models only, since it
 *  writes the reason a held call carries. */
export function toolReviewSecondLookChain(config: Config): ResolvedProviderConfig[] {
  return toolReviewChain(config, "toolReviewSecondLook").filter((step) => step.kind !== "decision");
}

/** Whether the review can run: it holds a call back only on a second look. */
export function toolReviewAvailable(config: Config): boolean {
  return toolReviewSecondLookChain(config).length > 0;
}

/** A route's model and fallbacks: its own where the file sets them, else the
 *  default's — the same rule for every route. */
function resolveAgentRoute(
  config: Config,
  fileAgent: JsonObject,
  route: AgentRoute,
  defaultSelection: AgentModelSelection
) {
  const defaultModel = defaultSelection.model;
  const modelKey = `${route}Model` as const;
  const fallbacksKey = `${route}ModelFallbacks` as const;
  const selection = hasExplicitAgentSelection(fileAgent, modelKey)
    ? normalizeAgentModelSelection(config.agent[modelKey], defaultModel)
    : defaultSelection;
  const resolved = resolveModelSelection(config, selection);
  config.agent[route] = resolved;
  config.agent[modelKey] = {
    model: resolved.modelRef,
    reasoningEffort: resolved.reasoningEffort,
    ...tierField(selection.serviceTier)
  };
  const fallbackInput = hasExplicitAgentSelection(fileAgent, fallbacksKey)
    ? config.agent[fallbacksKey]
    : config.models.default.modelFallbacks;
  const fallbacks = normalizeAgentModelSelectionList(fallbackInput, resolved.modelRef)
    .filter((fallback) => fallback.model !== resolved.modelRef);
  config.agent[fallbacksKey] = fallbacks;
  config.agent[`${route}Fallbacks` as const] = resolvedFallbackProviders(config, fallbacks);
}

/** The provider a voice setting names: by its name, else the one voice
 *  provider whose name it is in other case (the save used to lowercase
 *  names). "openai" alone is OpenAI's own realtime API, never a provider. */
function voiceProviderName(config: Config, name: string): string {
  const providers = config.models.providers ?? {};
  if (!name || providers[name] || name.toLowerCase() === "openai") return name;
  const matches = Object.keys(providers).filter((other) =>
    other.toLowerCase() === name.toLowerCase() && SUPPORTED_VOICE_PROVIDER_TYPES.has(providers[other]!.type));
  return matches.length === 1 ? matches[0]! : name;
}

export function normalizeVoiceConfig(config: Config, fileVoice: JsonObject) {
  const rawProvider = typeof config.voice.provider === "string" ? config.voice.provider.trim() : "";
  const namedProvider = voiceProviderName(config, normalizeProviderName(rawProvider));
  const namedProviderCfg = namedProvider ? config.models.providers?.[namedProvider] : undefined;
  let providerName = "";
  let providerType = "";

  // A provider's name, else OpenAI's realtime API with the voice's own key.
  if (namedProviderCfg && SUPPORTED_VOICE_PROVIDER_TYPES.has(namedProviderCfg.type)) {
    providerName = namedProvider;
    providerType = namedProviderCfg.type;
  } else {
    providerType = DEFAULT_CONFIG.voice.provider;
  }

  config.voice.provider = providerName || providerType;
  config.voice.providerName = providerName;
  config.voice.providerType = providerType;

  const modelExplicit = Object.hasOwn(fileVoice, "model");
  config.voice.model = normalizeOptionalString(config.voice.model);
  if (providerType === "codex" && !modelExplicit) {
    config.voice.model = DEFAULT_CODEX_REALTIME_MODEL;
  }
  if (!config.voice.model) {
    config.voice.model =
      providerType === "codex" ? DEFAULT_CODEX_REALTIME_MODEL : DEFAULT_CONFIG.voice.model;
  }

  config.voice.voice = normalizeOptionalString(config.voice.voice) || DEFAULT_CONFIG.voice.voice;
  config.voice.language =
    normalizeOptionalString(config.voice.language) || DEFAULT_CONFIG.voice.language;
  if (providerType === "codex") {
    config.voice.apiKey = "";
    config.voice.baseURL = "";
    config.voice.deployment = "";
    return;
  }

  config.voice.baseURL = normalizeOptionalString(config.voice.baseURL);
  config.voice.deployment = normalizeOptionalString(config.voice.deployment);
  const providerCfg = providerName ? providerConfig(config, providerName) : null;
  config.voice.apiKey = normalizeOptionalString(config.voice.apiKey) || providerCfg?.apiKey || "";
}

/** A model's typed cache lifetime as the file holds it (the check keeps it
 *  whole minutes within the limits), or nothing (the family's default). */
function cacheLifetimeOf(value: unknown): { cacheLifetimeMinutes?: number } {
  return typeof value === "number" ? { cacheLifetimeMinutes: value } : {};
}

/** The cache lifetime typed for a model (idle compaction), in minutes;
 *  undefined when none is typed or the model is not listed. */
export function modelCacheLifetimeMinutes(config: Config, modelRef: string): number | undefined {
  return findModelCapability(config, modelRef)?.cacheLifetimeMinutes;
}

function findModelCapability(
  config: Config,
  modelRef: string
): ModelCapabilityConfig | null {
  const resolved = parseModelRef(modelRef);
  if (!resolved) return null;
  // A name the providers' object inherits ("constructor", "__proto__") is no provider.
  if (!Object.hasOwn(config.models.providers, resolved.providerName)) return null;
  return config.models.providers[resolved.providerName]?.models.find((model) => model.id === resolved.model) ?? null;
}

export function modelSupportsInput(
  config: Config,
  modelRef: string,
  input: ModelInputType
): boolean {
  if (input === "text") return true;
  const capability = findModelCapability(config, modelRef);
  // A model missing from its provider's list takes images like any other;
  // its entry, when there is one, decides.
  if (!capability) return DEFAULT_MODEL_INPUTS.includes(input);
  return capability.input.includes(input);
}

/** Any model ref with its effort, resolved as a route's model is: its
 *  provider, the API it is served on, its key and address. `api`: the API a
 *  custom provider's model is reached on this time, whatever the model is set
 *  to (a gateway may serve both); other providers have one. */
export function resolveModelSelection(
  config: Config,
  selection: AgentModelSelection,
  opts: { api?: "responses" | "messages" } = {}
): ResolvedProviderConfig {
  const resolved = parseModelRef(selection.model);
  if (!resolved) {
    return {
      providerName: "",
      provider: "",
      providerType: "",
      model: "",
      modelRef: "",
      reasoningEffort: selection.reasoningEffort,
      baseURL: "",
      organizationId: "",
      apiKey: "",
      serviceTier: ""
    };
  }
  const providerCfg = providerConfig(config, resolved.providerName);
  const capability = findModelCapability(config, selection.model);
  // A custom provider's model may speak another API. Messages runs as the
  // Anthropic family (its SDK, its options, its cache marks) at the
  // provider's own address; the configured type stays for Settings.
  // Responses is the one with no protocol of its own.
  const protocol = providerCfg.type !== "openai-compatible"
    ? undefined
    : opts.api === "messages" ? "messages" : opts.api === "responses" ? undefined : capability?.protocol;
  // With no address of its own, a Messages model would go to Anthropic's
  // host with whatever key the custom provider has: such a model is not
  // configured.
  const keyless = protocol === "messages" && !providerCfg.baseURL;
  const api = apiOf(providerCfg.type, protocol, resolved.providerName, resolved.model);
  return {
    providerName: resolved.providerName,
    provider: familyOf(providerCfg.type, protocol, api),
    providerType: providerCfg.type,
    ...(protocol ? { protocol } : {}),
    ...(api ? { api } : {}),
    model: resolved.model,
    modelRef: selection.model,
    reasoningEffort: selection.reasoningEffort,
    supportsReasoning: capability?.supportsReasoning !== false,
    ...(capability?.kind === "decision" ? { kind: "decision" as const } : {}),
    baseURL: providerCfg.baseURL,
    organizationId: providerCfg.organizationId ?? "",
    apiKey: keyless ? "" : providerCfg.apiKey,
    // Codex has one tier for the provider; elsewhere it is the step's, on
    // the APIs that have the field (a decision model's Decisions API has none).
    serviceTier: providerCfg.type === "codex"
      ? providerCfg.serviceTier ?? ""
      : capability?.kind !== "decision" && stepTakesServiceTier(providerCfg.type, protocol) ? selection.serviceTier ?? "" : ""
  };
}

/** The family a model runs as: a custom provider's Messages model and a Kilo
 *  model tagged for Messages as Anthropic (its SDK, options and cache marks),
 *  a Kilo model tagged for Responses as OpenAI-compatible; otherwise its type. */
function familyOf(type: string, protocol: "chat" | "messages" | undefined, api: LlmApi | undefined): string {
  if (protocol === "messages") return "anthropic";
  if (type === "kilo" && api === "messages") return "anthropic";
  if (type === "kilo" && api === "responses") return "openai-compatible";
  return type;
}

/** The API a model speaks: a Kilo model the one Kilo tags it with, a custom
 *  provider's its protocol (Responses by default), the others their one. */
function apiOf(type: string, protocol: "chat" | "messages" | undefined, providerName: string, model: string): LlmApi | undefined {
  switch (type) {
    case "kilo": return kiloModelApi(providerName, model);
    case "openai-compatible": return protocol ?? "responses";
    case "anthropic": return "messages";
    case "openai":
    case "codex": return "responses";
    case "google": return "gemini";
    default: return undefined;
  }
}

function resolvedFallbackProviders(
  config: Config,
  selections: AgentModelSelection[]
): ResolvedProviderConfig[] {
  const fallbacks: ResolvedProviderConfig[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.model)) continue;
    const resolved = resolveModelSelection(config, selection);
    if (!resolved.provider || !resolved.model || !resolved.modelRef) continue;
    fallbacks.push(resolved);
    seen.add(selection.model);
  }
  return fallbacks;
}

function providerConfig(config: Config, providerName: string): ProviderConfig {
  const current = config.models.providers[providerName];
  const type = normalizeProviderType(current?.type);
  const defaults = PROVIDER_DEFAULTS[type] ?? { baseURL: "" };
  return {
    type,
    baseURL: normalizeOptionalString(current?.baseURL || defaults.baseURL),
    apiKey: providerApiKey(type, current?.apiKey),
    models: normalizeModelCapabilities(current?.models, type),
    ...(type === "kilo"
      ? { organizationId: normalizeOptionalString(current?.organizationId) }
      : {}),
    ...(type === "codex" ? { serviceTier: normalizeServiceTier(current?.serviceTier) } : {}),
    ...billingOf(current?.billing)
  };
}

/** A stored billing choice; anything else is no choice (the type's default). */
function billingOf(value: unknown): { billing?: ProviderBilling } {
  return typeof value === "string" && (PROVIDER_BILLING_VALUES as readonly string[]).includes(value)
    ? { billing: value as ProviderBilling }
    : {};
}

/** `provider/model`, or `fallbackRef` (the route's default) when the value is
 *  not one: a ref without its provider names no model. */
function normalizeModelRef(value: unknown, fallbackRef: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const resolved = raw ? parseModelRef(raw) : null;
  if (resolved) return `${resolved.providerName}/${resolved.model}`;
  const fallback = parseModelRef(fallbackRef);
  if (fallback) return `${fallback.providerName}/${fallback.model}`;
  return "";
}

function normalizeAgentModelSelection(value: unknown, fallbackRef: string): AgentModelSelection {
  const rawModel = isObject(value) ? value.model : value;
  const model = normalizeModelRef(rawModel, fallbackRef);
  return {
    model,
    reasoningEffort: normalizeReasoningEffort(isObject(value) ? value.reasoningEffort : undefined),
    ...tierField(isObject(value) ? value.serviceTier : undefined)
  };
}

/** A step's tier as it is kept: only one that is set. */
function tierField(value: unknown): { serviceTier?: ServiceTier } {
  const tier = normalizeServiceTier(value);
  return tier ? { serviceTier: tier } : {};
}

function normalizeAgentModelSelectionList(value: unknown, fallbackRef: string): AgentModelSelection[] {
  if (!Array.isArray(value)) return [];
  const selections: AgentModelSelection[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const selection = normalizeAgentModelSelection(item, fallbackRef);
    if (!selection.model || seen.has(selection.model)) continue;
    selections.push(selection);
    seen.add(selection.model);
  }
  return selections;
}

/** `provider/model` as Settings names it, when Settings lists it as a chat
 *  model (not a decision model): what a thread may be switched to. Null for
 *  anything else. */
export function listedChatModelRef(config: Config, modelRef: string): string | null {
  const capability = findModelCapability(config, modelRef);
  const parsed = parseModelRef(modelRef);
  return capability && capability.kind !== "decision" && parsed ? `${parsed.providerName}/${parsed.model}` : null;
}

/** The chat models Settings lists, by provider, both in Settings' order. */
export function chatModelChoices(config: Config): Array<{ providerName: string; models: string[] }> {
  return Object.entries(config.models.providers)
    .map(([providerName, provider]) => ({
      providerName,
      models: provider.models.filter((model) => model.kind !== "decision").map((model) => model.id)
    }))
    .filter((group) => group.models.length > 0);
}

export function hasExplicitAgentSelection(fileAgent: JsonObject, key: string): boolean {
  if (!Object.hasOwn(fileAgent, key)) return false;
  const value = fileAgent[key];
  if (value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

function parseModelRef(value: string): { providerName: string; model: string } | null {
  const raw = value.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0) return null;
  const providerName = normalizeProviderName(raw.slice(0, slash));
  const model = raw.slice(slash + 1).trim();
  return providerName && model ? { providerName, model } : null;
}


function providerApiKey(providerType: string, configured: unknown) {
  if (providerType === "codex") {
    return "";
  }
  return normalizeOptionalString(configured);
}

function normalizeModelCapabilities(value: unknown, providerType: string): ModelCapabilityConfig[] {
  if (!Array.isArray(value)) return [];
  const models: ModelCapabilityConfig[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const id = normalizeOptionalString(entry.id);
    if (!id || seen.has(id)) continue;
    // An entry without `input` takes the default (text + image).
    const input = Array.isArray(entry.input) ? normalizeModelInputs(entry.input) : [...DEFAULT_MODEL_INPUTS];
    // Only a custom provider chooses its models' API; the others have one.
    const protocol = providerType === "openai-compatible" ? normalizeModelProtocol(entry.protocol) : undefined;
    // Only a custom provider can serve the Decisions API.
    const decision = providerType === "openai-compatible" && entry.kind === "decision";
    // A price the file holds that does not parse is no price: Automatic.
    const price = parseModelPriceSetting(entry.price);
    models.push({
      id,
      input,
      ...(typeof entry.supportsReasoning === "boolean"
        ? { supportsReasoning: entry.supportsReasoning }
        : {}),
      ...(protocol ? { protocol } : {}),
      ...(decision ? { kind: "decision" as const } : {}),
      ...(price.ok ? { price: price.value } : {}),
      ...cacheLifetimeOf(entry.cacheLifetimeMinutes)
    });
    seen.add(id);
  }
  return models;
}

/** "chat" or "messages"; "responses", an unknown value or none is the
 *  default, kept as nothing. */
function normalizeModelProtocol(value: unknown): Exclude<ModelProtocol, "responses"> | undefined {
  return value === "chat" || value === "messages" ? value : undefined;
}

function normalizeModelInputs(value: unknown): ModelInputType[] {
  const inputs = new Set<ModelInputType>(["text"]);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const normalized = item.trim().toLowerCase();
      if (MODEL_INPUT_TYPES.has(normalized as ModelInputType)) {
        inputs.add(normalized as ModelInputType);
      }
    }
  }
  return [...inputs];
}
