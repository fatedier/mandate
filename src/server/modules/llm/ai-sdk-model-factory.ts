import { createAnthropic } from "@ai-sdk/anthropic";
import { getModelCapabilities } from "@ai-sdk/anthropic/internal";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel, type EmbeddingModel, type LanguageModel } from "ai";
import { createCodexOAuthLanguageModel } from "../codex/codex-oauth-provider.js";
import { anthropicApiBase } from "./anthropic-base-url.js";
import { kiloChatMiddleware } from "./kilo-chat-middleware.js";
import { createOpenResponsesModel, isOpenAiModelId } from "./open-responses-model.js";

export type AiProviderType =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "kilo"
  | "codex"
  | "google"
  | "";

interface AiLanguageModelConfig {
  provider: AiProviderType;
  /** The configured type when the model runs as another family: a Kilo
   *  model on Messages runs as Anthropic, on Responses as OpenAI-compatible. */
  providerType?: string;
  providerName?: string;
  apiKey?: string;
  baseURL?: string;
  organizationId?: string;
  serviceTier?: string;
  model: string;
  fetch?: typeof fetch;
  openaiModelApi?: "default" | "chat";
  openaiProviderName?: string;
  /** Build a Responses model with `@ai-sdk/openai` whatever model it is: a
   *  caller that needs that package's own tools (model search's web_search). */
  responsesSdk?: "openai";
}

interface AiEmbeddingModelConfig {
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
    case "anthropic": {
      const sdkModel = anthropicSdkModelId(cfg.model);
      const fetch = sdkModel === cfg.model ? cfg.fetch : withRequestModel(cfg.fetch, sdkModel, cfg.model);
      // Kilo takes its key as a Bearer token (it refuses x-api-key), as Kilo's own client sends it.
      const model = withUnknownModelOutputCap(createAnthropic(cfg.providerType === "kilo"
        ? { authToken: cfg.apiKey, baseURL: kiloApiBase(cfg.baseURL), headers: kiloHeaders(cfg.organizationId), fetch }
        : { apiKey: cfg.apiKey, baseURL: anthropicApiBase(cfg.baseURL), fetch })(sdkModel));
      // Outside, the model keeps its configured id.
      return sdkModel === cfg.model ? model : wrapLanguageModel({ model, middleware: { specificationVersion: "v4" }, modelId: cfg.model });
    }
    case "openai-compatible":
      // A model that is not OpenAI's own, on Responses: the package that
      // carries its raw reasoning back (open-responses-model.ts).
      if (cfg.openaiModelApi !== "chat" && cfg.responsesSdk !== "openai" && !isOpenAiModelId(cfg.model)) {
        const kilo = cfg.providerType === "kilo";
        return createOpenResponsesModel({
          model: cfg.model,
          url: `${kilo ? kiloApiBase(cfg.baseURL) : (cfg.baseURL ?? "").replace(/\/+$/, "")}/responses`,
          apiKey: cfg.apiKey,
          ...(kilo ? { headers: kiloHeaders(cfg.organizationId) } : {}),
          fetch: cfg.fetch
        });
      }
      if (cfg.providerType === "kilo") {
        return createOpenAI({
          apiKey: cfg.apiKey,
          baseURL: kiloApiBase(cfg.baseURL),
          name: cfg.openaiProviderName ?? cfg.providerName ?? "kilo",
          headers: kiloHeaders(cfg.organizationId),
          fetch: cfg.fetch
        })(cfg.model);
      }
    // falls through
    case "openai": {
      const provider = createOpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined,
        name: cfg.openaiProviderName,
        fetch: cfg.fetch
      });
      return cfg.openaiModelApi === "chat" ? provider.chat(cfg.model) : provider(cfg.model);
    }
    case "kilo":
      // A Kilo model on Chat, through OpenRouter's SDK as Kilo's own client
      // builds it: it carries the model's reasoning_details back.
      return wrapLanguageModel({
        model: createOpenRouter({
          apiKey: cfg.apiKey,
          baseURL: kiloApiBase(cfg.baseURL),
          headers: kiloHeaders(cfg.organizationId),
          fetch: cfg.fetch
        })(cfg.model),
        middleware: kiloChatMiddleware
      });
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

/** What a Messages model the Anthropic SDK does not know may write in all,
 *  thinking included: the SDK would hold its reply to 4,096 tokens. */
const UNKNOWN_MODEL_MAX_OUTPUT_TOKENS = 32_000;

/** Only a non-Claude id falls to the SDK's conservative default: every id
 *  its table places — known, a legacy family held to 4,096, or newer than the
 *  table — carries `claude-`. The SDK adds a thinking budget on top of the
 *  cap, never more than its table's maximum for the id, so that comes off it;
 *  a caller's own cap still wins. */
function withUnknownModelOutputCap(model: ReturnType<ReturnType<typeof createAnthropic>>) {
  if (model.modelId.includes("claude-")) return model;
  const { maxOutputTokens } = getModelCapabilities(model.modelId);
  return wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({
      settings: { maxOutputTokens: UNKNOWN_MODEL_MAX_OUTPUT_TOKENS - maxOutputTokens }
    })
  });
}

/**
 * The name the Anthropic SDK reads a model's limits from (output cap, thinking,
 * effort). It knows Claude versions dashed (`claude-haiku-4-5`); a gateway that
 * writes them with a dot (Kilo, OpenRouter: `anthropic/claude-haiku-4.5`) would
 * be read as an unknown model or an older one. The dashed name when the SDK
 * knows it, else the id as configured.
 */
function anthropicSdkModelId(model: string): string {
  const dashed = model.replace(/(\d)\.(\d)/g, "$1-$2");
  return dashed !== model && getModelCapabilities(dashed).isKnownModel ? dashed : model;
}

/** Whether the Anthropic SDK has this model think adaptively (no thinking
 *  budget added to its output cap), as it reads the id. */
export function anthropicThinkingIsAdaptive(model: string): boolean {
  return getModelCapabilities(anthropicSdkModelId(model)).supportsAdaptiveThinking === true;
}

/** Sends the configured id in the request when the SDK was given another name. */
function withRequestModel(base: typeof fetch | undefined, sdkModel: string, model: string): typeof fetch {
  // The global fetch as it is at each call (a test or a wrapper may replace it).
  const send = (input: RequestInfo | URL, init?: RequestInit) => (base ?? globalThis.fetch)(input, init);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== "string") return send(input, init);
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return send(input, init);
    }
    if (!body || typeof body !== "object" || (body as { model?: unknown }).model !== sdkModel) return send(input, init);
    return send(input, { ...init, body: JSON.stringify({ ...body, model }) });
  }) as typeof fetch;
}

/** Kilo's gateway with its version segment (Kilo's client calls `/api/gateway/v1`). */
function kiloApiBase(baseURL: string | undefined): string {
  const base = (baseURL ?? "").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
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
