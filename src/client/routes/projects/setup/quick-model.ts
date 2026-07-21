import type {
  ModelCapabilitySettings,
  ProviderSettingsUpdate,
  ProviderType,
  SettingsConfigResponse,
  SettingsConfigUpdate
} from "@/routes/settings/types";
import type { QuickModelForm } from "./types";

export function quickModelFormFromConfig(
  config: SettingsConfigResponse,
  preferredProviderName?: string
): QuickModelForm {
  const providerNames = Object.keys(config.models.providers);
  if (!preferredProviderName && providerNames.length === 0) {
    return blankQuickModelForm("openai-compatible");
  }
  const defaultRef = splitModelRef(config.models.default.model);
  const providerName = preferredProviderName || defaultRef.providerName || providerNames[0] || "";
  const provider = config.models.providers[providerName];
  const providerType = provider?.type ?? "codex";
  return {
    providerName,
    providerType,
    model: defaultRef.providerName === providerName ? defaultRef.model : "",
    baseURL: providerType === "codex" ? "" : (provider?.baseURL ?? ""),
    organizationId: providerType === "kilo" ? (provider?.organizationId ?? "") : "",
    apiKey: ""
  };
}

export function blankQuickModelForm(providerType: ProviderType): QuickModelForm {
  return {
    providerName: "",
    providerType,
    model: "",
    baseURL: "",
    organizationId: "",
    apiKey: ""
  };
}

export function defaultProviderName(providerType: ProviderType): string {
  if (providerType === "openai-compatible") return "proxy";
  return providerType;
}

export function buildQuickModelPayload(
  config: SettingsConfigResponse,
  form: QuickModelForm
): SettingsConfigUpdate {
  const providerName = form.providerName.trim();
  const model = form.model.trim();
  const modelRef = `${providerName}/${model}`;
  const providers = preserveProviders(config);
  const currentProvider = config.models.providers[providerName];
  const providerPayload: ProviderSettingsUpdate = {
    type: form.providerType,
    models: buildModelCapabilities(model),
    apiKey: form.providerType === "codex" ? "" : form.apiKey,
    clearApiKey: false
  };
  if (form.providerType !== "codex") {
    providerPayload.baseURL = form.baseURL;
    if (form.providerType === "kilo") {
      providerPayload.organizationId = form.organizationId;
    }
  } else {
    providerPayload.serviceTier =
      currentProvider?.type === "codex"
        ? codexServiceTierForUpdate(currentProvider.serviceTier)
        : "";
  }
  providers[providerName] = providerPayload;

  return {
    models: {
      default: {
        model: modelRef,
        reasoningEffort: config.models.default.reasoningEffort,
        modelFallbacks: config.models.default.modelFallbacks
      },
      providers
    },
    agent: {
      managerModel: {
        ...config.agent.managerModel,
        model: modelRef
      },
      managerModelFallbacks: config.agent.managerModelFallbacks,
      workerModel: {
        ...config.agent.workerModel,
        model: modelRef
      },
      workerModelFallbacks: config.agent.workerModelFallbacks
    }
  };
}

function preserveProviders(config: SettingsConfigResponse): Record<string, ProviderSettingsUpdate> {
  return Object.fromEntries(
    Object.entries(config.models.providers).map(([name, provider]) => [
      name,
      {
        type: provider.type,
        baseURL: provider.type === "codex" ? undefined : provider.baseURL,
        organizationId: provider.type === "kilo" ? provider.organizationId : undefined,
        serviceTier:
          provider.type === "codex" ? codexServiceTierForUpdate(provider.serviceTier) : undefined,
        models: provider.models,
        apiKey: "",
        clearApiKey: false
      } satisfies ProviderSettingsUpdate
    ])
  );
}

function buildModelCapabilities(model: string): ModelCapabilitySettings[] {
  return Array.from(new Set([model].map((item) => item.trim()).filter(Boolean))).map((id) => ({
    id,
    input: ["text", "image"]
  }));
}

export function validateQuickModelForm(form: QuickModelForm): string {
  const providerNameError = validateProviderName(form.providerName);
  if (providerNameError) return providerNameError;
  if (!form.model.trim()) return "Default model is required.";
  return "";
}

export function validateProviderName(providerName: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(providerName.trim())) {
    return "Provider names may use letters, numbers, dot, underscore, and hyphen.";
  }
  return "";
}

function splitModelRef(ref: string): { providerName: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0) return { providerName: "", model: ref };
  return { providerName: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function codexServiceTierForUpdate(
  value: string | undefined
): ProviderSettingsUpdate["serviceTier"] {
  if (value === "priority" || value === "flex") return value;
  return "";
}
