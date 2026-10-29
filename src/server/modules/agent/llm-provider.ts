import type { LanguageModel } from "ai";
import type { ReasoningEffort } from "../../../shared/settings.js";
import type { LlmApi } from "../../../shared/llm-api.js";
import {
  createAiSdkLanguageModel,
  createDisabledLanguageModel,
  type AiProviderType
} from "../llm/ai-sdk-model-factory.js";

export interface AgentProviderConfig {
  provider: AiProviderType;
  /** The configured type, when it differs from the API family the model
   *  runs as (a custom provider's Messages model runs as Anthropic). */
  providerType?: string;
  providerName?: string;
  apiKey?: string;
  baseURL?: string;
  organizationId?: string;
  serviceTier?: string;
  reasoningEffort: ReasoningEffort;
  supportsReasoning?: boolean;
  /** Chat Completions instead of Responses, for a custom provider's model. */
  openaiModelApi?: "chat";
  /** The API the model speaks (from resolution). */
  api?: LlmApi;
  /** Build a Responses model with `@ai-sdk/openai` whatever model it is. */
  responsesSdk?: "openai";
  /** What the model's requests go through instead of the global fetch. */
  fetch?: typeof fetch;
  model: string;
}

export interface AgentProviderInstance {
  model: LanguageModel;
  meta: {
    provider: string;
    providerType: string;
    providerName: string;
    model: string;
    baseURL: string;
    reasoningEffort: ReasoningEffort;
    supportsReasoning?: boolean;
    api?: LlmApi;
  };
}

/**
 * Build a LanguageModel instance from agent config. Returns the configured
 * model and metadata used for logging and provider-specific behavior.
 */
export function createAgentProvider(cfg: AgentProviderConfig): AgentProviderInstance {
  const instance = createAgentProviderFor(cfg);
  return cfg.api ? { ...instance, meta: { ...instance.meta, api: cfg.api } } : instance;
}

function createAgentProviderFor(cfg: AgentProviderConfig): AgentProviderInstance {
  if (!cfg.provider || !cfg.model) {
    return {
      model: createDisabledModel("Agent model is not configured."),
      meta: {
        provider: cfg.provider || "not-configured",
        providerType: cfg.providerType || cfg.provider || "not-configured",
        providerName: cfg.providerName || "",
        model: cfg.model || "",
        baseURL: cfg.baseURL || "",
        reasoningEffort: cfg.reasoningEffort,
        supportsReasoning: cfg.supportsReasoning
      }
    };
  }
  switch (cfg.provider) {
    case "anthropic": {
      return {
        model:
          createAiSdkLanguageModel({
            provider: "anthropic",
            providerType: cfg.providerType,
            providerName: cfg.providerName,
            model: cfg.model,
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL,
            organizationId: cfg.organizationId,
            ...(cfg.fetch ? { fetch: cfg.fetch } : {})
          }) ?? createDisabledModel("Anthropic agent provider is missing model or API key."),
        meta: {
          provider: "anthropic",
          providerType: cfg.providerType || cfg.provider || "not-configured",
        providerName: cfg.providerName || "",
          model: cfg.model,
          baseURL: cfg.baseURL || "",
          reasoningEffort: cfg.reasoningEffort,
          supportsReasoning: cfg.supportsReasoning
        }
      };
    }
    case "openai": {
      return {
        model:
          createAiSdkLanguageModel({
            provider: "openai",
            model: cfg.model,
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL
          }) ?? createDisabledModel("OpenAI agent provider is missing model or API key."),
        meta: {
          provider: "openai",
          providerType: cfg.providerType || cfg.provider || "not-configured",
        providerName: cfg.providerName || "",
          model: cfg.model,
          baseURL: cfg.baseURL || "",
          reasoningEffort: cfg.reasoningEffort,
          supportsReasoning: cfg.supportsReasoning
        }
      };
    }
    case "openai-compatible": {
      return {
        model:
          createAiSdkLanguageModel({
            provider: "openai-compatible",
            providerType: cfg.providerType,
            providerName: cfg.providerName,
            model: cfg.model,
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL,
            organizationId: cfg.organizationId,
            openaiModelApi: cfg.openaiModelApi,
            ...(cfg.responsesSdk ? { responsesSdk: cfg.responsesSdk } : {})
          }) ??
          createDisabledModel("OpenAI-compatible agent provider is missing model or API key."),
        meta: {
          provider: "openai-compatible",
          providerType: cfg.providerType || cfg.provider || "not-configured",
        providerName: cfg.providerName || "",
          model: cfg.model,
          baseURL: cfg.baseURL || "",
          reasoningEffort: cfg.reasoningEffort,
          supportsReasoning: cfg.supportsReasoning
        }
      };
    }
    case "kilo": {
      return {
        model:
          createAiSdkLanguageModel({
            provider: "kilo",
            model: cfg.model,
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL,
            organizationId: cfg.organizationId
          }) ?? createDisabledModel("Kilo Gateway agent provider is missing model or API key."),
        meta: {
          provider: "kilo",
          providerType: cfg.providerType || cfg.provider || "not-configured",
        providerName: cfg.providerName || "",
          model: cfg.model,
          baseURL: cfg.baseURL || "",
          reasoningEffort: cfg.reasoningEffort,
          supportsReasoning: cfg.supportsReasoning
        }
      };
    }
    case "codex": {
      const providerName = cfg.providerName || "codex";
      return {
        model:
          createAiSdkLanguageModel({
            provider: "codex",
            providerName,
            model: cfg.model,
            baseURL: cfg.baseURL,
            serviceTier: cfg.serviceTier
          }) ?? createDisabledModel("Codex agent provider is missing model."),
        meta: {
          provider: "codex",
          providerType: cfg.providerType || cfg.provider,
          providerName,
          model: cfg.model,
          baseURL: cfg.baseURL || "",
          reasoningEffort: cfg.reasoningEffort,
          supportsReasoning: cfg.supportsReasoning
        }
      };
    }
    case "google": {
      return {
        model:
          createAiSdkLanguageModel({
            provider: "google",
            model: cfg.model,
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL
          }) ?? createDisabledModel("Google agent provider is missing model or API key."),
        meta: {
          provider: "google",
          providerType: cfg.providerType || cfg.provider || "not-configured",
        providerName: cfg.providerName || "",
          model: cfg.model,
          baseURL: cfg.baseURL || "",
          reasoningEffort: cfg.reasoningEffort,
          supportsReasoning: cfg.supportsReasoning
        }
      };
    }
    default:
      return {
        model: createDisabledModel(`Unknown agent provider: ${cfg.provider}`),
        meta: {
          provider: cfg.provider || "unknown",
          providerType: cfg.providerType || cfg.provider || "not-configured",
        providerName: cfg.providerName || "",
          model: cfg.model || "",
          baseURL: cfg.baseURL || "",
          reasoningEffort: cfg.reasoningEffort,
          supportsReasoning: cfg.supportsReasoning
        }
      };
  }
}

function createDisabledModel(message: string): LanguageModel {
  return createDisabledLanguageModel(message);
}
