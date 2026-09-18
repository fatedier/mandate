import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { resolveCodexAccess, type CodexAuthProfile, type CodexAuthStoreSource } from "./codex-auth-store.js";
import { codexResponsesStream } from "./codex-responses-stream.js";
import { withCodexUserAgent } from "./codex-http.js";
import {
  globalHttpClient,
  type HttpClient
} from "../../platform/http/http-client.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import { formatErrorMessage } from "../../platform/errors.js";
import codexDefaultInstructionsPath from "./prompts/codex-default-instructions.md" with { type: "file" };

const CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DUMMY_API_KEY = "mandate-codex-oauth";

export interface CodexOAuthProviderConfig {
  providerName: string;
  model: string;
  baseURL?: string;
  serviceTier?: string;
  httpClient?: HttpClient;
  authStore?: CodexAuthStoreSource;
}

export class CodexHttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly statusCode: number;
  readonly statusText: string;
  readonly detail?: string;
  readonly requestId?: string;

  constructor(input: {
    status: number;
    statusText: string;
    detail?: string;
    requestId?: string | null;
  }) {
    const statusText = input.statusText.trim();
    const title = `OpenAI Codex API HTTP ${input.status} ${statusText}`.trim();
    const requestId = input.requestId?.trim();
    const detail = input.detail?.trim();
    super([
      title,
      detail,
      requestId ? `request_id=${requestId}` : ""
    ].filter(Boolean).join(": "));
    this.name = "CodexHttpError";
    this.code = `codex_http_${input.status}`;
    this.status = input.status;
    this.statusCode = input.status;
    this.statusText = statusText;
    if (detail) this.detail = detail;
    if (requestId) this.requestId = requestId;
  }
}

export class CodexTransportError extends Error {
  constructor(cause: unknown) {
    super(`Codex request failed: ${formatErrorMessage(cause, "transport error")}`, { cause });
    this.name = "CodexTransportError";
  }
}

export function createCodexOAuthLanguageModel(cfg: CodexOAuthProviderConfig) {
  const httpClient = cfg.httpClient ?? globalHttpClient;
  const provider = createOpenAI({
    name: "codex",
    apiKey: DUMMY_API_KEY,
    baseURL: stripTrailingSlash(cfg.baseURL || CODEX_RESPONSES_BASE_URL),
    // Cast: Bun's fetch type carries a `preconnect` member a plain function
    // does not; the SDK only ever calls it.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      const profile = await waitForCodexAccess(
        resolveCodexAccess(cfg.providerName, cfg.authStore, { httpClient }), init?.signal
      );
      // This fetch belongs exclusively to the Codex provider, including custom
      // proxy base URLs. Protocol adaptation must not depend on the hostname.
      const requestInit = normalizeCodexResponsesRequest(init, cfg.serviceTier);
      const send = async (credential: CodexAuthProfile) => {
        init?.signal?.throwIfAborted();
        const headers = withCodexUserAgent(init?.headers);
        headers.set("authorization", `Bearer ${credential.access}`);
        headers.set("originator", "mandate");
        headers.delete("ChatGPT-Account-Id");
        if (credential.accountId) headers.set("ChatGPT-Account-Id", credential.accountId);
        try {
          return await httpClient.fetch(input, { ...requestInit, headers });
        } catch (error) {
          throw codexTransportErrorFromCause(error);
        }
      };
      let response = await send(profile);
      if (response.status === 401) {
        await response.body?.cancel();
        init?.signal?.throwIfAborted();
        const refreshed = await waitForCodexAccess(resolveCodexAccess(cfg.providerName, cfg.authStore, {
          httpClient,
          rejectedAccessToken: profile.access
        }), init?.signal);
        if (refreshed.accountId !== profile.accountId) {
          throw new Error("OpenAI Codex account changed during request recovery. Retry the request.");
        }
        response = await send(refreshed);
      }
      if (!response.ok) {
        throw await codexHttpErrorFromResponse(response);
      }
      return response;
    }) as unknown as typeof fetch
  });
  return wrapLanguageModel({
    model: provider.responses(cfg.model),
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: { ...params.providerOptions?.openai, store: false }
        }
      }),
      wrapStream: async ({ model, params }) => {
        const result = await model.doStream({ ...params, includeRawChunks: true });
        return {
          ...result,
          stream: codexResponsesStream(result.stream, params.abortSignal, params.includeRawChunks)
        };
      }
    }
  });
}

function waitForCodexAccess(access: Promise<CodexAuthProfile>, signal?: AbortSignal | null) {
  if (!signal) return access;
  // Cancel this caller's wait, not the refresh owned by the shared auth store.
  return new Promise<CodexAuthProfile>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    access.then(profile => {
      signal.removeEventListener("abort", onAbort);
      resolve(profile);
    }, error => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function codexTransportErrorFromCause(cause: unknown): CodexTransportError {
  return new CodexTransportError(cause);
}

export function normalizeCodexResponsesRequest(
  init: RequestInit | undefined,
  serviceTier?: string
): RequestInit | undefined {
  const body = init?.body;
  if (typeof body !== "string") return init;

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return init;
  }

  if (!isRecord(payload) || !Array.isArray(payload.input)) {
    return init;
  }

  const instructions: string[] = [];
  const nextInput: unknown[] = [];
  for (const item of payload.input) {
    if (isSystemInputItem(item)) {
      const text = textFromInputContent(item.content);
      if (text) instructions.push(text);
    } else {
      // Stored item IDs are not usable references with store:false. Keep
      // function call IDs, content, encrypted reasoning and message phase.
      if (isRecord(item) && (item.type === "reasoning" || item.type === "function_call"
        || item.role === "assistant")) delete item.id;
      nextInput.push(item);
    }
  }

  const currentInstructions = typeof payload.instructions === "string" ? payload.instructions.trim() : "";
  payload.instructions = [currentInstructions, ...instructions].filter(Boolean).join("\n\n")
    || renderPromptFile(codexDefaultInstructionsPath);
  payload.input = nextInput;
  payload.store = false;
  payload.include = [...new Set([
    ...(Array.isArray(payload.include) ? payload.include : []),
    "reasoning.encrypted_content"
  ])];
  const normalizedServiceTier = normalizeCodexServiceTier(serviceTier);
  if (normalizedServiceTier) {
    payload.service_tier = normalizedServiceTier;
  } else if (typeof payload.service_tier === "string") {
    const existingServiceTier = normalizeCodexServiceTier(payload.service_tier);
    if (existingServiceTier) {
      payload.service_tier = existingServiceTier;
    } else {
      delete payload.service_tier;
    }
  }

  return {
    ...init,
    body: JSON.stringify(payload)
  };
}

function isSystemInputItem(item: unknown) {
  return isRecord(item) && (item.role === "system" || item.role === "developer");
}

function textFromInputContent(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      const item = part;
      return typeof item.text === "string" ? item.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function codexHttpErrorFromResponse(response: Response) {
  const body = await response.clone().text().catch(() => "");
  const requestId = response.headers.get("x-oai-request-id");
  const detail = detailFromErrorBody(body);
  return new CodexHttpError({
    status: response.status,
    statusText: response.statusText,
    detail,
    requestId
  });
}

function detailFromErrorBody(body: string) {
  if (!body.trim()) return "";
  try {
    const parsed = JSON.parse(body);
    if (!isRecord(parsed)) return body.slice(0, 500);
    const error = isRecord(parsed.error) ? parsed.error : null;
    if (typeof parsed.detail === "string") return parsed.detail;
    if (typeof error?.message === "string") return error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    return body.slice(0, 500);
  }
  return body.slice(0, 500);
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeCodexServiceTier(value: unknown) {
  if (typeof value !== "string") return "";
  const tier = value.trim().toLowerCase();
  if (!tier) return "";
  if (tier === "priority" || tier === "flex") return tier;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
