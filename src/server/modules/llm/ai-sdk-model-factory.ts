import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";
import { createCodexOAuthLanguageModel } from "../codex/codex-oauth-provider.js";

export type AiProviderType =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "kilo"
  | "codex"
  | "google"
  | "";

export interface AiLanguageModelConfig {
  provider: AiProviderType;
  providerName?: string;
  apiKey?: string;
  baseURL?: string;
  organizationId?: string;
  serviceTier?: string;
  model: string;
  fetch?: typeof fetch;
  openaiModelApi?: "default" | "chat";
  openaiProviderName?: string;
}

export interface AiEmbeddingModelConfig {
  providerType: string;
  providerName: string;
  apiKey?: string;
  baseURL?: string;
  model: string;
  fetch?: typeof fetch;
}

export function createAiSdkLanguageModel(cfg: AiLanguageModelConfig): LanguageModel | null {
  if (!cfg.model) return null;
  if (cfg.provider !== "codex" && !cfg.apiKey) return null;

  switch (cfg.provider) {
    case "anthropic":
      return createAnthropic({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined,
        fetch: cfg.fetch
      })(cfg.model);
    case "openai":
    case "openai-compatible": {
      const provider = createOpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined,
        name: cfg.openaiProviderName,
        fetch: cfg.fetch
      });
      return cfg.openaiModelApi === "chat" ? provider.chat(cfg.model) : provider(cfg.model);
    }
    case "kilo": {
      const provider = createOpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined,
        name: cfg.openaiProviderName ?? "kilo",
        headers: kiloHeaders(cfg.organizationId),
        fetch: cfg.fetch
      });
      return provider.chat(cfg.model);
    }
    case "codex":
      return createCodexOAuthLanguageModel({
        providerName: cfg.providerName || "codex",
        model: cfg.model,
        baseURL: cfg.baseURL || undefined,
        serviceTier: cfg.serviceTier || undefined
      });
    case "google":
      return createGoogleGenerativeAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined,
        fetch: cfg.fetch
      })(cfg.model);
    default:
      return null;
  }
}

function kiloHeaders(organizationId: string | undefined) {
  const trimmed = organizationId?.trim();
  return trimmed ? { "X-KiloCode-OrganizationId": trimmed } : undefined;
}

export function createAiSdkEmbeddingModel(cfg: AiEmbeddingModelConfig): EmbeddingModel | null {
  switch (cfg.providerType) {
    case "openai": {
      const provider = createOpenAI({
        apiKey: cfg.apiKey,
        fetch: cfg.fetch
      });
      return provider.embedding(cfg.model as never);
    }
    case "openai-compatible": {
      const provider = createOpenAI({
        name: cfg.providerName,
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined,
        fetch: cfg.fetch
      });
      return provider.embedding(cfg.model as never);
    }
    case "google": {
      const provider = createGoogleGenerativeAI({
        apiKey: cfg.apiKey,
        fetch: cfg.fetch
      });
      return provider.embedding(cfg.model as never);
    }
    default:
      return null;
  }
}

export function createDisabledLanguageModel(message: string): LanguageModel {
  const fail = async () => {
    throw new Error(message);
  };
  return {
    specificationVersion: "v4",
    provider: "mandate",
    modelId: "not-configured",
    supportedUrls: {},
    doGenerate: fail,
    doStream: fail
  } as LanguageModel;
}
