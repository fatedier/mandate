import { redactSecrets } from "./text/text.js";
import type { AgentWakeErrorCategory, AgentWakeUserErrorDto } from "../../shared/api/agents.js";

const MAX_ERROR_MESSAGE_LENGTH = 4000;
const MAX_USER_ERROR_MESSAGE_LENGTH = 180;
const PLACEHOLDER_OBJECT_MESSAGE = "[object Object]";

export function formatErrorMessage(error: unknown, fallback = "operation failed"): string {
  const message = formatErrorMessageInner(error, new WeakSet());
  return limitErrorMessage(message || fallback);
}

export function toUserFacingError(error: unknown, fallback = "Operation failed."): AgentWakeUserErrorDto {
  const detail = formatErrorMessage(error, fallback);
  const signals = collectErrorSignals(error, new WeakSet(), 0);
  const haystack = [
    detail,
    ...signals.codes,
    ...signals.types,
    ...signals.names,
    ...signals.text
  ].join(" ").toLowerCase();
  const status = signals.statuses[0] ?? null;
  const code = signals.codes[0] ?? signals.types[0] ?? (status !== null ? String(status) : undefined);

  const classified = classifyError(haystack, status);
  return {
    message: classified.message ?? safeUserMessage(detail, fallback),
    category: classified.category,
    ...(code ? { code } : {}),
    retryable: classified.retryable,
    ...(detail && detail !== classified.message ? { detail } : {})
  };
}

export function isKnownOperationalError(error: unknown): boolean {
  const detail = formatErrorMessage(error, "");
  const signals = collectErrorSignals(error, new WeakSet(), 0);
  const haystack = [
    detail,
    ...signals.codes,
    ...signals.types,
    ...signals.names,
    ...signals.text
  ].join(" ").toLowerCase();
  const status = signals.statuses[0] ?? null;
  return classifyError(haystack, status).category !== "unknown";
}

function formatErrorMessageInner(error: unknown, seen: WeakSet<object>): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  const domExceptionMessage = messageFromDomException(error);
  if (domExceptionMessage) return domExceptionMessage;
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const message = meaningfulString(error.message);
    if (message) {
      const causeDomExceptionMessage = messageFromDomException(cause);
      if (
        causeDomExceptionMessage &&
        causeDomExceptionMessage !== message &&
        causeDomExceptionMessage.startsWith(message)
      ) {
        return causeDomExceptionMessage;
      }
      return message;
    }
    const causeMessage = cause === undefined ? "" : formatErrorMessageInner(cause, seen);
    if (causeMessage) return causeMessage;
    return serializeErrorProperties(error, seen);
  }
  if (typeof error !== "object") return String(error);
  return messageFromRecord(error as Record<string, unknown>, seen) || serializeObject(error, seen);
}

function messageFromRecord(record: Record<string, unknown>, seen: WeakSet<object>): string {
  const nested = nestedProviderErrorMessage(record, seen);
  if (nested) return nested;

  for (const key of ["message", "error", "detail", "details", "reason", "body", "responseBody", "data"]) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value === "string") {
      const message = meaningfulString(value);
      if (message) return withCode(message, record);
      continue;
    }
    const message = formatErrorMessageInner(value, seen);
    if (message) return withCode(message, record);
  }
  const status = stringField(record, "status") || stringField(record, "statusCode") || stringField(record, "code");
  if (status) return `Request failed (${status}).`;
  return "";
}

function nestedProviderErrorMessage(record: Record<string, unknown>, seen: WeakSet<object>): string {
  const nested = record.error;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return "";
  const message = messageFromRecord(nested as Record<string, unknown>, seen);
  if (!message) return "";
  return withCode(message, nested as Record<string, unknown>);
}

function withCode(message: string, record: Record<string, unknown>): string {
  const code = stringField(record, "code");
  const type = stringField(record, "type");
  const status = stringField(record, "status") || stringField(record, "statusCode");
  const suffix = code || type || status;
  return suffix && !message.includes(suffix) ? `${message} (${suffix})` : message;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return meaningfulString(value);
  if (typeof value === "number") return String(value);
  return "";
}

function meaningfulString(value: string): string {
  const message = value.trim();
  return message && message !== PLACEHOLDER_OBJECT_MESSAGE ? message : "";
}

function messageFromDomException(value: unknown): string {
  if (!isDomExceptionLike(value)) return "";
  const record = value as Record<string, unknown>;
  const message = meaningfulString(String(record.message));
  if (!message) return "";
  const name = typeof record.name === "string" ? meaningfulString(record.name) : "";
  const code = typeof record.code === "number" && Number.isFinite(record.code)
    ? `code=${record.code}`
    : "";
  const suffix = [name, code].filter(Boolean).join(" ");
  return suffix && !message.includes(suffix) ? `${message} (${suffix})` : message;
}

function isDomExceptionLike(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" &&
    typeof record.message === "string" &&
    typeof record.code === "number" &&
    (
      "TIMEOUT_ERR" in record ||
      "ABORT_ERR" in record ||
      "INDEX_SIZE_ERR" in record
    );
}

function serializeErrorProperties(error: Error, seen: WeakSet<object>): string {
  const entries = Object.entries(error).filter(([key]) => !["name", "message", "stack", "cause"].includes(key));
  if (entries.length === 0) return "";
  return serializeObject(Object.fromEntries(entries), seen);
}

function serializeObject(value: object, seen: WeakSet<object>): string {
  if (seen.has(value)) return "[Circular]";
  try {
    const json = JSON.stringify(sanitizeErrorValue(value, seen, 0));
    return json && json !== "{}" ? json : "";
  } catch {
    return "";
  }
}

function sanitizeErrorValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(limitErrorMessage(value));
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: meaningfulString(value.message) || undefined,
      cause: sanitizeErrorValue((value as Error & { cause?: unknown }).cause, seen, depth + 1)
    };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth > 5) return "[Max depth]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeErrorValue(item, seen, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "function" || typeof child === "symbol") continue;
    output[key] = sanitizeErrorValue(child, seen, depth + 1);
  }
  return output;
}

function limitErrorMessage(value: string): string {
  const redacted = redactSecrets(value);
  if (redacted.length <= MAX_ERROR_MESSAGE_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...[truncated ${redacted.length - MAX_ERROR_MESSAGE_LENGTH} chars]`;
}

interface ErrorSignals {
  codes: string[];
  types: string[];
  names: string[];
  statuses: number[];
  text: string[];
}

function emptySignals(): ErrorSignals {
  return { codes: [], types: [], names: [], statuses: [], text: [] };
}

function collectErrorSignals(error: unknown, seen: WeakSet<object>, depth: number): ErrorSignals {
  const signals = emptySignals();
  if (error === null || error === undefined || depth > 6) return signals;
  if (typeof error === "string") {
    pushText(signals.text, error);
    const parsed = parseJson(error);
    if (parsed !== null) mergeSignals(signals, collectErrorSignals(parsed, seen, depth + 1));
    return signals;
  }
  if (typeof error === "number") {
    if (Number.isInteger(error)) signals.statuses.push(error);
    return signals;
  }
  if (typeof error !== "object") {
    pushText(signals.text, String(error));
    return signals;
  }
  if (seen.has(error)) return signals;
  seen.add(error);

  if (error instanceof Error) {
    pushText(signals.names, error.name);
    pushText(signals.text, error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined) mergeSignals(signals, collectErrorSignals(cause, seen, depth + 1));
  }

  const record = error as Record<string, unknown>;
  pushText(signals.codes, stringField(record, "code"));
  pushText(signals.types, stringField(record, "type"));
  pushText(signals.names, stringField(record, "name"));
  for (const key of ["status", "statusCode"]) {
    const status = Number(record[key]);
    if (Number.isInteger(status)) signals.statuses.push(status);
  }
  for (const key of ["message", "detail", "details", "reason"]) {
    const value = record[key];
    if (typeof value === "string") pushText(signals.text, value);
  }
  for (const key of ["error", "cause", "body", "responseBody", "data"]) {
    if (key in record) mergeSignals(signals, collectErrorSignals(record[key], seen, depth + 1));
  }
  dedupeSignals(signals);
  return signals;
}

function classifyError(
  haystack: string,
  status: number | null
): { category: AgentWakeErrorCategory; message?: string; retryable: boolean } {
  if (
    haystack.includes("server_is_overloaded") ||
    haystack.includes("server is overloaded") ||
    haystack.includes("servers are currently overloaded") ||
    haystack.includes("temporarily overloaded") ||
    status === 529
  ) {
    return {
      category: "provider_overloaded",
      message: "Model provider is overloaded. Please retry shortly.",
      retryable: true
    };
  }
  if (status === 429 || haystack.includes("rate_limit") || haystack.includes("rate limit") || haystack.includes("too many requests")) {
    return {
      category: "rate_limited",
      message: "Model provider rate limit hit. Please retry later.",
      retryable: true
    };
  }
  if (haystack.includes("timeout") || haystack.includes("timed out") || status === 408 || status === 504) {
    return {
      category: "timeout",
      message: "Model request timed out. Please retry.",
      retryable: true
    };
  }
  if (
    haystack.includes("context length") ||
    haystack.includes("context window") ||
    haystack.includes("maximum context") ||
    haystack.includes("too many tokens") ||
    haystack.includes("token limit")
  ) {
    return {
      category: "context_too_large",
      message: "Context is too large. Start a new chat or reduce the input.",
      retryable: false
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    haystack.includes("unauthorized") ||
    haystack.includes("forbidden") ||
    haystack.includes("invalid api key") ||
    haystack.includes("authentication failed")
  ) {
    return {
      category: "auth_failed",
      message: "Model provider authentication failed. Check the provider login or API key.",
      retryable: false
    };
  }
  if (status === 400 || haystack.includes("bad request") || haystack.includes("invalid request")) {
    return {
      category: "invalid_request",
      message: "Model provider rejected the request. Check the model, provider configuration, or input.",
      retryable: false
    };
  }
  if (
    status !== null && status >= 500 ||
    haystack.includes("internal server error") ||
    haystack.includes("service unavailable") ||
    haystack.includes("bad gateway") ||
    haystack.includes("gateway timeout")
  ) {
    return {
      category: "provider_error",
      message: "Model provider returned an error. Please retry shortly.",
      retryable: true
    };
  }
  return { category: "unknown", retryable: false };
}

function safeUserMessage(detail: string, fallback: string): string {
  const cleaned = detail.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === PLACEHOLDER_OBJECT_MESSAGE) return fallback;
  return cleaned.length > MAX_USER_ERROR_MESSAGE_LENGTH
    ? `${cleaned.slice(0, MAX_USER_ERROR_MESSAGE_LENGTH).trimEnd()}...`
    : cleaned;
}

function parseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function pushText(target: string[], value: string): void {
  const text = meaningfulString(value);
  if (text) target.push(text);
}

function mergeSignals(target: ErrorSignals, source: ErrorSignals): void {
  target.codes.push(...source.codes);
  target.types.push(...source.types);
  target.names.push(...source.names);
  target.statuses.push(...source.statuses);
  target.text.push(...source.text);
}

function dedupeSignals(signals: ErrorSignals): void {
  signals.codes = [...new Set(signals.codes)];
  signals.types = [...new Set(signals.types)];
  signals.names = [...new Set(signals.names)];
  signals.statuses = [...new Set(signals.statuses)];
  signals.text = [...new Set(signals.text)];
}
