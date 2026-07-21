import type { JSONObject, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { ReasoningEffort } from "../../../shared/settings.js";

export type AiSdkReasoningEffort = Exclude<ReasoningEffort, "provider-default">;

export function reasoningForAiSdk(
  value: ReasoningEffort | undefined,
  supportsReasoning?: boolean
): AiSdkReasoningEffort | undefined {
  if (supportsReasoning === false) return undefined;
  return value && value !== "provider-default" ? value : undefined;
}

export function providerOptionsWithReasoningForAiSdk(
  existing: SharedV4ProviderOptions | undefined,
  provider: string | undefined,
  value: ReasoningEffort | undefined,
  supportsReasoning?: boolean
): SharedV4ProviderOptions | undefined {
  if (
    !reasoningForAiSdk(value, supportsReasoning) ||
    supportsReasoning !== true ||
    !isOpenAiLikeProvider(provider)
  ) {
    return existing;
  }
  const openai: JSONObject = existing?.openai ?? {};
  return {
    ...existing,
    openai: {
      ...openai,
      forceReasoning: true
    }
  };
}

function isOpenAiLikeProvider(provider: string | undefined): boolean {
  return provider === "openai" ||
    provider === "openai-compatible" ||
    provider === "codex" ||
    provider === "openai.responses" ||
    provider === "openai.chat" ||
    provider === "codex.responses" ||
    provider === "codex.chat";
}
