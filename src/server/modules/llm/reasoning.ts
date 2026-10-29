import type { JSONObject, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { ReasoningEffort } from "../../../shared/settings.js";

type AiSdkReasoningEffort = Exclude<ReasoningEffort, "provider-default">;

export function reasoningForAiSdk(
  value: ReasoningEffort | undefined,
  supportsReasoning?: boolean
): AiSdkReasoningEffort | undefined {
  if (supportsReasoning === false) return undefined;
  return value && value !== "provider-default" ? value : undefined;
}

/** Reasoning is on unless the model is marked off. */
export function reasoningOn(supportsReasoning?: boolean): boolean {
  return supportsReasoning !== false;
}

export function providerOptionsWithReasoningForAiSdk(
  existing: SharedV4ProviderOptions | undefined,
  provider: string | undefined,
  supportsReasoning?: boolean
): SharedV4ProviderOptions | undefined {
  // Reasoning on (the default) makes an OpenAI-style model a reasoning one
  // for the AI SDK whatever the effort: without forceReasoning the SDK takes a
  // proxied id such as `openai/gpt-6.1-sol` for non-reasoning and drops every
  // reasoning option, the summary request included.
  if (!reasoningOn(supportsReasoning) || !isOpenAiLikeProvider(provider)) {
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

/** An error that refuses the reasoning summary: a gateway (or an account)
 *  that does not take the optional summary request. It names the parameter —
 *  on the error (Codex), in a stream error's frame (`data`), or in its message
 *  or body — whatever the status (a gateway may stamp every
 *  failure 500). Read from the error and the causes it wraps. */
export function isReasoningSummaryRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const e = current as { statusCode?: unknown; status?: unknown; message?: unknown; responseBody?: unknown; param?: unknown; data?: unknown; value?: unknown; cause?: unknown };
    if (namedParams(e).includes("reasoning.summary")) return true;
    const text = [e.message, e.responseBody].filter((part): part is string => typeof part === "string").join(" ");
    if (/reasoning\.summary|reasoning summar/i.test(text)) return true;
    current = e.cause;
  }
  return false;
}

/** The request parameters an error names: its own, and its stream frame's
 *  (`{ param }`, `{ error: { param } }`, `{ response: { error: { param } } }`)
 *  — the frame is `data` on a provider stream error, `value` on the SDK's
 *  type-validation error for a frame it could not parse. */
function namedParams(e: { param?: unknown; data?: unknown; value?: unknown }): unknown[] {
  const record = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});
  return [e.param, ...[e.data, e.value].flatMap((frame) => {
    const f = record(frame);
    return [f.param, record(f.error).param, record(record(f.response).error).param];
  })];
}
