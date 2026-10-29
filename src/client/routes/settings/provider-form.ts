import { randomId } from "@/lib/random-id";
import type { CodexAuthStatus } from "./settings-codex-auth";
import type { ProviderCheckState } from "./useProviderChecks";
import type { ModelPriceSetting, ProviderBilling } from "@shared/api/pricing";
import { providerBilling } from "@shared/settings";
import { cacheFamilyOf, type CacheFamily } from "@shared/llm-api";
import {
  CODEX_BUILTIN_MODEL_IDS,
  DEFAULT_MODEL_INPUTS,
  type CodexServiceTier,
  type ModelCapabilitySettings,
  type ModelInputType,
  type ModelProtocol,
  PROVIDER_BASE_URL_DEFAULTS,
  PROVIDER_DEFAULT_MODEL_IDS,
  type ProviderSettingsUpdate,
  type ProviderType,
  type SettingsConfigResponse,
  type SettingsConfigUpdate
} from "./types";

export type ProviderForm = {
  id: string;
  originalName: string;
  name: string;
  type: ProviderType;
  baseURL: string;
  organizationId: string;
  serviceTier: CodexServiceTier;
  /** How the connection charges; saved with the connection. */
  billing: ProviderBilling;
  models: ModelForm[];
  apiKey: string;
  clearApiKey: boolean;
  configured: boolean;
  auth?: CodexAuthStatus;
};

export type ModelForm = {
  id: string;
  modelId: string;
  input: ModelInputType[];
  supportsReasoning: boolean;
  /** The API a custom provider's model is spoken to over; sent only for one. */
  protocol: ModelProtocol;
  /** A chat model or a decision model; "decision" is sent only for a custom provider's. */
  kind: "chat" | "decision";
  /** The model's price setting; absent, Automatic. Carried through every save:
   *  the server rebuilds a provider's models from what is sent. */
  price?: ModelPriceSetting;
  /** The model's cache lifetime in minutes, as typed; empty or absent, the
   *  family's default. Sent only when typed. */
  cacheLifetimeMinutes?: string;
};

/** Which default cache lifetime a model has: Claude's hour, GPT's 30 minutes,
 *  or none — the server's rule, on the family the model runs as. */
export type ModelCacheFamily = CacheFamily;

export function modelCacheFamily(providerType: ProviderType, protocol: ModelProtocol, modelId: string): ModelCacheFamily {
  return cacheFamilyOf(runsAs(providerType, protocol, modelId), modelId);
}

/** The family model resolution gives a model (its familyOf): a Messages model
 *  the Anthropic family; a Kilo model by the API Kilo tags it with, which only
 *  the server knows — told here by the vendor Kilo tags by (`anthropic/…`
 *  Messages, `openai/…` Responses, any other Chat); otherwise its type. */
function runsAs(providerType: ProviderType, protocol: ModelProtocol, modelId: string): string {
  if (protocol === "messages") return "anthropic";
  if (providerType !== "kilo") return providerType;
  const id = modelId.trim().toLowerCase().replace(/^~/, "");
  if (id.startsWith("anthropic/")) return "anthropic";
  return id.startsWith("openai/") ? "openai-compatible" : "kilo";
}

/** A typed cache lifetime: empty, or whole minutes; Claude's at most 60, the
 *  hour Mandate asks it for. */
export function cacheLifetimeError(raw: string, family: ModelCacheFamily): string {
  const text = raw.trim();
  if (!text) return "";
  if (!/^\d+$/.test(text)) return "Enter whole minutes, 0 or more.";
  if (family === "claude" && Number(text) > 60) return "At most 60 for a Claude model.";
  return "";
}

export type ProviderSetupTemplateId =
  | "codex"
  | "openai"
  | "kilo"
  | "anthropic"
  | "google"
  | "openai-compatible";

type ProviderSetupTemplate = {
  id: ProviderSetupTemplateId;
  title: string;
  detail: string;
  defaultName: string;
  type: ProviderType;
  defaultModelIds: readonly string[];
};

export const PROVIDER_SETUP_TEMPLATES: readonly ProviderSetupTemplate[] = [
  {
    id: "codex",
    title: "OpenAI Codex",
    detail: "Use browser sign-in with a Codex account.",
    defaultName: "codex",
    type: "codex",
    defaultModelIds: CODEX_BUILTIN_MODEL_IDS
  },
  {
    id: "openai",
    title: "OpenAI API",
    detail: "Use an OpenAI API key.",
    defaultName: "openai",
    type: "openai",
    defaultModelIds: [PROVIDER_DEFAULT_MODEL_IDS.openai]
  },
  {
    id: "kilo",
    title: "Kilo Gateway",
    detail: "Use a Kilo Gateway API key.",
    defaultName: "kilo",
    type: "kilo",
    defaultModelIds: [PROVIDER_DEFAULT_MODEL_IDS.kilo]
  },
  {
    id: "anthropic",
    title: "Anthropic",
    detail: "Use an Anthropic API key.",
    defaultName: "anthropic",
    type: "anthropic",
    defaultModelIds: [PROVIDER_DEFAULT_MODEL_IDS.anthropic]
  },
  {
    id: "google",
    title: "Google",
    detail: "Use a Google AI API key.",
    defaultName: "google",
    type: "google",
    defaultModelIds: [PROVIDER_DEFAULT_MODEL_IDS.google]
  },
  {
    id: "openai-compatible",
    title: "OpenAI compatible",
    detail: "Use a custom endpoint that speaks the OpenAI API.",
    defaultName: "provider",
    type: "openai-compatible",
    defaultModelIds: []
  }
];

/** A provider card pairs the editable form with its last-saved baseline (null = new, never saved). */
export type ProviderCard = {
  form: ProviderForm;
  baseline: ProviderForm | null;
};

export function providerFormsFromConfig(config: SettingsConfigResponse): ProviderForm[] {
  return Object.entries(config.models.providers).map(([name, provider]) => ({
    id: randomId(),
    originalName: name,
    name,
    type: provider.type,
    baseURL: provider.baseURL,
    organizationId: provider.organizationId ?? "",
    serviceTier: serviceTierForForm(provider.serviceTier),
    billing: providerBilling(provider),
    models: provider.models.map((model) => ({
      id: randomId(),
      modelId: model.id,
      input: model.input,
      supportsReasoning: reasoningForForm(model.supportsReasoning),
      protocol: model.protocol ?? "responses",
      kind: model.kind ?? "chat",
      ...(model.price ? { price: model.price } : {}),
      ...(model.cacheLifetimeMinutes !== undefined ? { cacheLifetimeMinutes: String(model.cacheLifetimeMinutes) } : {})
    })),
    apiKey: "",
    clearApiKey: false,
    configured: provider.apiKeyConfigured,
    auth: provider.auth
  }));
}

/**
 * Serialize a form for dirty comparison, ignoring the volatile client-side ids.
 *
 * Relies on stable key insertion order: JSON.stringify emits keys in insertion
 * order, and both construction paths (providerFormsFromConfig, makeNewProvider)
 * build forms from the same literal shape. Any future construction path must
 * preserve that key order, or clean forms will compare as dirty.
 */
export function serializeProviderForm({ id: _id, models, ...rest }: ProviderForm): string {
  return JSON.stringify({
    ...rest,
    models: models.map(modelContent)
  });
}

/** A model row's content without its client id: did the dialog change it. */
export function serializeModelForm(model: ModelForm): string {
  return JSON.stringify(modelContent(model));
}

/** A model's settings in one order, whatever order they were set in (a
 *  setting the dialog removes and puts back lands last). */
function modelContent({ id: _id, ...model }: ModelForm) {
  return Object.fromEntries(Object.entries(model).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * What a provider's row says. A saved key is not a working one: only a
 * check says Ready or Check failed, and until one answers it is "Key
 * saved". Codex's status is its sign-in; an expired token is its own state,
 * since it still reports `configured`.
 */
export type ProviderStatus =
  | "not-saved"
  | "signed-in"
  | "expired"
  | "signed-out"
  | "no-key"
  | "checking"
  | "ready"
  | "failed"
  | "key-saved";

export function providerStatus(card: ProviderCard, check: ProviderCheckState | undefined): ProviderStatus {
  const form = card.form;
  if (card.baseline === null) return "not-saved";
  if (form.type === "codex") {
    if (!form.auth?.configured) return "signed-out";
    return form.auth.status === "expired" ? "expired" : "signed-in";
  }
  if (!form.configured) return "no-key";
  if (check?.phase === "checking") return "checking";
  if (check?.phase === "done" && check.check.result === "ready") return "ready";
  if (check?.phase === "done" && check.check.result === "failed") return "failed";
  return "key-saved";
}

export const PROVIDER_STATUS_CHIP: Record<ProviderStatus, { tone: "ready" | "attention" | "idle" | "failed"; label: string }> = {
  "not-saved": { tone: "idle", label: "Not saved" },
  "signed-in": { tone: "ready", label: "Signed in" },
  expired: { tone: "attention", label: "Sign-in expired" },
  "signed-out": { tone: "idle", label: "Not signed in" },
  "no-key": { tone: "idle", label: "No key" },
  checking: { tone: "idle", label: "Checking…" },
  ready: { tone: "ready", label: "Ready" },
  failed: { tone: "failed", label: "Check failed" },
  "key-saved": { tone: "idle", label: "Key saved" }
};

/** The saved settings a check depends on (the key itself the client never
 *  sees; a replaced key is caught by the check that follows its save). */
export function connectionOf(form: Pick<ProviderForm, "type" | "baseURL" | "organizationId">): string {
  return [form.type, form.baseURL, form.organizationId].join("\n");
}

/** The name a card is saved under: a saved provider's own (a name is fixed
 *  once saved, since model references and a Codex login are keyed by it), or
 *  a new card's typed one. */
export function providerKey(form: Pick<ProviderForm, "originalName" | "name">): string {
  return (form.originalName || form.name).trim();
}

/**
 * Build the providers patch for a per-card save or delete.
 *
 * The server's applyModelsPatch REPLACES the entire providers record with the
 * patch contents, so every card must contribute: the saved card its current
 * form, every other card its baseline, and unsaved-new cards (baseline null)
 * are skipped unless they are the save target. The deleted card is skipped
 * entirely.
 */
export function buildProvidersPatch(
  cards: ProviderCard[],
  target: { savedId?: string; deletedId?: string }
): SettingsConfigUpdate {
  const providers: Record<string, ProviderSettingsUpdate> = {};
  const seen = new Set<string>();
  for (const card of cards) {
    if (card.form.id === target.deletedId) continue;
    const provider = card.form.id === target.savedId ? card.form : card.baseline;
    if (!provider) continue;
    const name = providerKey(provider);
    if (!isValidProviderName(name))
      throw new Error("Provider names may use letters, numbers, dot, underscore, and hyphen.");
    if (seen.has(name)) throw new Error(`Duplicate provider name: ${name}`);
    seen.add(name);
    const providerPayload: ProviderSettingsUpdate = {
      type: provider.type,
      baseURL: provider.baseURL,
      organizationId: provider.type === "kilo" ? provider.organizationId : undefined,
      billing: provider.billing,
      models: provider.models.map((model) => modelCapabilityForPayload(model, provider.type)),
      apiKey: provider.apiKey,
      clearApiKey: provider.clearApiKey
    };
    if (provider.type === "codex") {
      providerPayload.serviceTier = provider.serviceTier;
    }
    providers[name] = providerPayload;
  }
  return { models: { providers } };
}

export function makeNewProvider(
  existing: ProviderForm[],
  templateId: ProviderSetupTemplateId = "openai-compatible"
): ProviderForm {
  const template =
    PROVIDER_SETUP_TEMPLATES.find((item) => item.id === templateId) ??
    PROVIDER_SETUP_TEMPLATES.at(-1)!;
  const name = uniqueProviderName(existing, template.defaultName);
  const models = template.defaultModelIds.filter(Boolean).map((modelId) => ({
    id: randomId(),
    modelId,
    input: [...DEFAULT_MODEL_INPUTS],
    supportsReasoning: true,
    protocol: "responses" as const,
    kind: "chat" as const
  }));
  return {
    id: randomId(),
    originalName: "",
    name,
    type: template.type,
    baseURL: template.type === "codex" ? "" : PROVIDER_BASE_URL_DEFAULTS[template.type].baseURL,
    organizationId: "",
    serviceTier: "",
    billing: providerBilling({ type: template.type }),
    models,
    apiKey: "",
    clearApiKey: false,
    configured: false,
    auth: undefined
  };
}

/** Suffix sequence starts at 2: `openai`, `openai-2`, `openai-3`, … */
function uniqueProviderName(existing: ProviderForm[], baseName: string): string {
  const names = new Set(existing.map((provider) => provider.name));
  if (!names.has(baseName)) return baseName;
  let index = 2;
  while (names.has(`${baseName}-${index}`)) index += 1;
  return `${baseName}-${index}`;
}

export function isValidProviderName(name: string) {
  return /^[A-Za-z0-9._-]+$/.test(name.trim());
}

export function setModelInput(
  input: ModelInputType[],
  value: ModelInputType,
  enabled: boolean
): ModelInputType[] {
  const values = new Set<ModelInputType>(normalizeModelInputs(input));
  if (enabled) {
    values.add(value);
  } else if (value !== "text") {
    values.delete(value);
  }
  return [...values];
}

function normalizeModelInputs(input: ModelInputType[]): ModelInputType[] {
  const values = new Set<ModelInputType>(["text"]);
  if (input.includes("image")) values.add("image");
  return [...values];
}

/** Reasoning is on unless the stored model says off. */
function reasoningForForm(value: boolean | undefined): boolean {
  return value !== false;
}

function modelCapabilityForPayload(model: ModelForm, providerType: ProviderType): ModelCapabilitySettings {
  return {
    id: model.modelId.trim(),
    input: normalizeModelInputs(model.input),
    supportsReasoning: model.supportsReasoning,
    // Only a custom provider chooses its models' API; "responses" is the default.
    ...(providerType === "openai-compatible" && model.protocol !== "responses" ? { protocol: model.protocol } : {}),
    // Only a custom provider serves decision models.
    ...(providerType === "openai-compatible" && model.kind === "decision" ? { kind: "decision" as const } : {}),
    ...(model.price ? { price: model.price } : {}),
    // A decision model has no cache lifetime; one typed before it became one is hidden.
    ...(model.kind !== "decision" && model.cacheLifetimeMinutes?.trim() ? { cacheLifetimeMinutes: Number(model.cacheLifetimeMinutes.trim()) } : {})
  };
}

function serviceTierForForm(value: string | undefined): CodexServiceTier {
  if (value === "priority" || value === "flex") return value;
  return "";
}
