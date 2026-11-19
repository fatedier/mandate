import { createOpenResponses } from "@ai-sdk/open-responses";
import { createJsonErrorResponseHandler, zodSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { mapEventStreamData } from "./event-stream.js";
import type { LanguageModel } from "ai";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { reasoningOn } from "./reasoning.js";

/**
 * Models that are not OpenAI's own, on a Responses endpoint (a gateway, Kilo),
 * are built with the AI SDK's Open Responses package: it reads a model's raw
 * reasoning (`reasoning_text`, as DeepSeek returns it) and sends it back in
 * the next request, which `@ai-sdk/openai` — written for OpenAI's service,
 * where reasoning comes only as a summary and encrypted — does not.
 */

/** The package's name: its provider-options key; its models report
 *  `provider` as `openResponses.responses`. */
export const OPEN_RESPONSES_NAME = "openResponses";

export { isOpenAiModelId } from "../../../shared/llm-api.js";

/**
 * The fields Mandate sends every Responses model and the package does not:
 * no stored response, the encrypted reasoning back on a call that asks for
 * reasoning (as @ai-sdk/openai asks only of a model it takes for a reasoning
 * one: a model without it may refuse the field), and the thread as the cache
 * key (read from the step's own session header). Each only when the body
 * lacks it; a body that is not a JSON object goes as it is.
 */
export function withResponsesFields(base?: typeof fetch): typeof fetch {
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
    if (!body || typeof body !== "object" || Array.isArray(body)) return send(input, init);
    const fields: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    if (!("store" in fields)) fields.store = false;
    if (!("include" in fields) && fields.reasoning != null) fields.include = ["reasoning.encrypted_content"];
    const session = new Headers(init.headers).get("x-session-id");
    if (session && !("prompt_cache_key" in fields)) fields.prompt_cache_key = session;
    return withNestedStreamErrors(await send(input, { ...init, body: JSON.stringify(fields) }));
  }) as typeof fetch;
}

/**
 * OpenAI's Responses stream reports an error as a flat event (`{type:
 * "error", code, message}`); the package reads only the nested form
 * (`{type: "error", error: {...}}`) and fails on the flat one with a
 * TypeError, losing the provider's words and its status. A flat error event
 * is given the nested form beside its own fields; every other event passes
 * as it came.
 */
function withNestedStreamErrors(response: Response): Response {
  return mapEventStreamData(response, nestedErrorData);
}

function nestedErrorData(data: string): string {
  // An error event says "error" as its type: written as it is (`"error"`), or
  // with a letter escaped (`\u`), the only other way JSON spells it. Any other
  // event (nearly all of them) goes on unread, parsed once, by the package.
  if (!data.includes('"error"') && !data.includes("\\u")) return data;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return data;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return data;
  const event = value as Record<string, unknown>;
  if (event.type !== "error" || event.error != null) return data;
  const { code, message, param } = event;
  return JSON.stringify({ ...event, error: { code: code ?? null, message: typeof message === "string" ? message : "", param: param ?? null } });
}

/**
 * The status and retryability of an error a Responses stream reported, by
 * its code and type, as @ai-sdk/openai gives them (Mandate's retry policy
 * reads both): an HTTP status when the code is one, else by the words in it,
 * else a server error.
 */
export function streamErrorMetadata(error: { code?: unknown; type?: unknown }): { statusCode: number; isRetryable: boolean } {
  const explicit = typeof error.code === "number" ? error.code : typeof error.code === "string" && /^\d{3}$/.test(error.code) ? Number(error.code) : null;
  const words = [error.code, error.type].filter((value) => typeof value === "string" || typeof value === "number").join(" ").toLowerCase();
  const statusCode = explicit !== null && explicit >= 400 && explicit <= 599
    ? explicit
    : ["insufficient_quota", "rate_limit"].some((term) => words.includes(term)) ? 429
      : words.includes("authentication") ? 401
        : words.includes("permission") ? 403
          : words.includes("not_found") ? 404
            : ["invalid", "bad_request", "context_length"].some((term) => words.includes(term)) ? 400
              : words.includes("overload") ? 503
                : words.includes("timeout") ? 504
                  : 500;
  const quota = words.includes("insufficient_quota");
  return { statusCode, isRetryable: !quota && (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500) };
}

/**
 * An HTTP error body read as @ai-sdk/openai reads it: the package's own
 * schema takes only a string code and param, and a gateway that sends a
 * number (OpenRouter-style) lost its message to the status text ("Bad
 * Request"), which the retry policy reads as a request not to send elsewhere.
 */
const responsesErrorHandler = createJsonErrorResponseHandler({
  errorSchema: zodSchema(z.object({
    error: z.object({
      message: z.string(),
      type: z.string().nullish(),
      param: z.any().nullish(),
      code: z.union([z.string(), z.number()]).nullish()
    })
  })),
  errorToMessage: (data) => data.error.message
});

/** Whether a model was built with the Open Responses package. */
export function isOpenResponsesModel(model: LanguageModel): boolean {
  return typeof model !== "string" && model.provider === `${OPEN_RESPONSES_NAME}.responses`;
}

export function createOpenResponsesModel(cfg: {
  model: string;
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}): LanguageModel {
  return createOpenResponses({
    url: cfg.url,
    name: OPEN_RESPONSES_NAME,
    apiKey: cfg.apiKey,
    headers: cfg.headers,
    fetch: withResponsesFields(cfg.fetch),
    getResponseErrorMetadata: streamErrorMetadata,
    failedResponseHandler: responsesErrorHandler
  })(cfg.model);
}

/**
 * Whether a model refuses a step that has no reasoning of its own: DeepSeek
 * in thinking mode ("The `reasoning_text` in the thinking mode must be passed
 * back"). On the new package, with reasoning on (provider-default included:
 * DeepSeek thinks unless told not to). Such a model gets a one-space
 * reasoning placeholder on a step another model wrote (wake-message-adapter.ts);
 * an empty one is refused like none.
 */
export function needsReasoningPlaceholder(
  model: LanguageModel,
  reasoning: { reasoningEffort?: ReasoningEffort; supportsReasoning?: boolean }
): boolean {
  if (typeof model === "string" || !isOpenResponsesModel(model)) return false;
  if (!reasoningOn(reasoning.supportsReasoning) || reasoning.reasoningEffort === "none") return false;
  return model.modelId.toLowerCase().includes("deepseek");
}
