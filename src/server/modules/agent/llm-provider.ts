import type { LanguageModel } from "ai";
import type { ReasoningEffort } from "../../../shared/settings.js";
import {
  createAiSdkLanguageModel,
  createDisabledLanguageModel,
  type AiProviderType
} from "../llm/ai-sdk-model-factory.js";

export interface AgentProviderConfig {
  provider: AiProviderType;
  providerName?: string;
  apiKey?: string;
  baseURL?: string;
  organizationId?: string;
  serviceTier?: string;
  reasoningEffort: ReasoningEffort;
  supportsReasoning?: boolean;
  model: string;
}

export interface AgentProviderInstance {
  model: LanguageModel;
  meta: {
    provider: string;
    providerName: string;
    model: string;
    baseURL: string;
    reasoningEffort: ReasoningEffort;
    supportsReasoning?: boolean;
  };
}

/**
 * Build a LanguageModel instance from agent config. Returns the configured
 * model and metadata used for logging and provider-specific behavior.
 */
export function createAgentProvider(cfg: AgentProviderConfig): {
  model: LanguageModel;
  meta: {
    provider: string;
    providerName: string;
    model: string;
    baseURL: string;
    reasoningEffort: ReasoningEffort;
    supportsReasoning?: boolean;
  };
} {
  if (!cfg.provider || !cfg.model) {
    return {
      model: createDisabledModel("Agent model is not configured."),
      meta: {
        provider: cfg.provider || "not-configured",
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
            model: cfg.model,
            apiKey: cfg.apiKey
          }) ?? createDisabledModel("Anthropic agent provider is missing model or API key."),
        meta: {
          provider: "anthropic",
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
            apiKey: cfg.apiKey
          }) ?? createDisabledModel("OpenAI agent provider is missing model or API key."),
        meta: {
          provider: "openai",
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
            model: cfg.model,
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL
          }) ??
          createDisabledModel("OpenAI-compatible agent provider is missing model or API key."),
        meta: {
          provider: "openai-compatible",
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
            apiKey: cfg.apiKey
          }) ?? createDisabledModel("Google agent provider is missing model or API key."),
        meta: {
          provider: "google",
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
