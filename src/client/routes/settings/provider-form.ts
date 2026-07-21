import { randomId } from "@/lib/random-id";
import type { CodexAuthStatus } from "./settings-codex-auth";
import {
  CODEX_BUILTIN_MODEL_IDS,
  type CodexServiceTier,
  type ModelCapabilitySettings,
  type ModelInputType,
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
  supportsReasoning: ModelReasoningSupport;
};

export type ModelReasoningSupport = "auto" | "supported" | "unsupported";

export const MODEL_REASONING_SUPPORT_OPTIONS: ReadonlyArray<{
  value: ModelReasoningSupport;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "supported", label: "Supported" },
  { value: "unsupported", label: "Unsupported" }
];

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
    models: provider.models.map((model) => ({
      id: randomId(),
      modelId: model.id,
      input: model.input,
      supportsReasoning: reasoningSupportForForm(model.supportsReasoning)
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
    models: models.map(({ id: _modelId, ...model }) => model)
  });
}

export type ProviderStatus = "connected" | "signed-in" | "expired" | "unconfigured";

/**
 * `expired` is its own state, not a flavour of signed-in. An expired token
 * still reports `configured: true`, so folding it into "signed-in" showed a
 * green "Signed in" on a provider whose very next call would fail — while the
 * auth box right below it said "Expired". The status line has to agree with
 * what the provider will actually do.
 */
export function providerStatus(form: ProviderForm): ProviderStatus {
  if (form.type === "codex") {
    if (!form.auth?.configured) return "unconfigured";
    return form.auth.status === "expired" ? "expired" : "signed-in";
  }
  return form.configured ? "connected" : "unconfigured";
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
    const name = provider.name.trim();
    if (!isValidProviderName(name))
      throw new Error("Provider names may use letters, numbers, dot, underscore, and hyphen.");
    if (seen.has(name)) throw new Error(`Duplicate provider name: ${name}`);
    seen.add(name);
    const providerPayload: ProviderSettingsUpdate = {
      previousName:
        provider.originalName && provider.originalName !== name ? provider.originalName : undefined,
      type: provider.type,
      baseURL: provider.baseURL,
      organizationId: provider.type === "kilo" ? provider.organizationId : undefined,
      models: provider.models.map(modelCapabilityForPayload),
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
    input: ["text", "image"] as ModelInputType[],
    supportsReasoning: (template.type === "codex" ? "supported" : "auto") as ModelReasoningSupport
  }));
  return {
    id: randomId(),
    originalName: "",
    name,
    type: template.type,
    baseURL: template.type === "codex" ? "" : PROVIDER_BASE_URL_DEFAULTS[template.type].baseURL,
    organizationId: "",
    serviceTier: "",
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

export function reasoningSupportForForm(value: boolean | undefined): ModelReasoningSupport {
  if (value === true) return "supported";
  if (value === false) return "unsupported";
  return "auto";
}

function modelCapabilityForPayload(model: ModelForm): ModelCapabilitySettings {
  return {
    id: model.modelId.trim(),
    input: normalizeModelInputs(model.input),
    ...(model.supportsReasoning === "supported"
      ? { supportsReasoning: true }
      : model.supportsReasoning === "unsupported"
        ? { supportsReasoning: false }
        : {})
  };
}

function serviceTierForForm(value: string | undefined): CodexServiceTier {
  if (value === "priority" || value === "flex") return value;
  return "";
}
