// Helpers for normalizing/sanitizing data written into the llm_calls table.
// Used by agent wakes, compression, and other LLM-backed background work.

import { redactSecrets } from "../../platform/text/text.js";
import { formatErrorMessage } from "../../platform/errors.js";
import { getLogLevel } from "../../platform/logger.js";

export type LogRequestsMode = "off" | "metadata" | "full";

export function normalizeLogRequests(value: unknown): LogRequestsMode {
  if (typeof value !== "string") return "metadata";
  const mode = value.trim().toLowerCase();
  if (mode === "off" || mode === "metadata" || mode === "full") return mode;
  return "metadata";
}

export function responseForLog(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null;
  const response = isRecord(result.response) ? result.response : {};
  return {
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason,
    warnings: result.warnings,
    request: result.request,
    response: {
      id: response.id,
      modelId: response.modelId,
      timestamp: response.timestamp,
      headers: response.headers,
      messages: response.messages,
      body: response.body
    },
    providerMetadata: result.providerMetadata
  };
}

export function outputForLog(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null;
  const output: Record<string, unknown> = {};
  if (typeof result.text === "string") {
    output.text = result.text;
  }
  if (Array.isArray(result.toolCalls)) {
    output.toolCalls = result.toolCalls;
  }
  return Object.keys(output).length > 0 ? output : null;
}

export function extractUsage(usage: unknown) {
  const u = isRecord(usage) ? usage : null;
  const inputTokenDetails = isRecord(u?.inputTokenDetails) ? u.inputTokenDetails : {};
  const outputTokenDetails = isRecord(u?.outputTokenDetails) ? u.outputTokenDetails : {};
  const raw = u ? {
    inputTokens: numberOrUndefined(u.inputTokens),
    inputTokenDetails: u.inputTokenDetails,
    outputTokens: numberOrUndefined(u.outputTokens),
    outputTokenDetails: u.outputTokenDetails,
    totalTokens: numberOrUndefined(u.totalTokens),
    reasoningTokens: numberOrUndefined(outputTokenDetails.reasoningTokens ?? u.reasoningTokens),
    cachedInputTokens: numberOrUndefined(inputTokenDetails.cacheReadTokens ?? u.cachedInputTokens),
    raw: u.raw
  } : null;

  // Accept AI SDK input/output names and Mandate collector prompt/completion
  // names while older rows and tests still use both shapes.
  const inputTokens = numberOrUndefined(u?.inputTokens ?? u?.promptTokens);
  const outputTokens = numberOrUndefined(u?.outputTokens ?? u?.completionTokens);
  // total_tokens is what the Activity feed sums for the TOKENS KPI. Some
  // providers report it directly; others (and the agent's stream-collector)
  // don't, so fall back to input + output when both are known.
  const reportedTotal = numberOrUndefined(u?.totalTokens);
  const totalTokens = reportedTotal
    ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);

  return {
    raw,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens: numberOrUndefined(outputTokenDetails.reasoningTokens ?? u?.reasoningTokens),
    cacheReadTokens: numberOrUndefined(inputTokenDetails.cacheReadTokens ?? u?.cachedInputTokens),
    cacheWriteTokens: numberOrUndefined(inputTokenDetails.cacheWriteTokens)
  };
}

export function errorForLog(error: unknown): Record<string, unknown> {
  const err = isRecord(error) ? error : {};
  const output: Record<string, unknown> = {
    name: errorNameForLog(error) || "Error",
    message: formatErrorMessage(error, "Error"),
    ...errorMetadataForLog(error)
  };
  if (getLogLevel() === "debug") {
    const stack = stringValue(err.stack);
    if (stack) output.stack = stack;
    if (err.cause !== undefined) output.cause = err.cause;
  }
  return output;
}

export function sanitizeForLlmLog(value: unknown) {
  return sanitizeValue(value, new WeakSet());
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }
  if (isImagePayloadRecord(value)) return sanitizeImagePayloadRecord(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "function" || typeof child === "symbol") continue;
    if (isEncryptedReasoningField(key) && typeof child === "string") {
      output[key] = `[omitted encrypted reasoning content ${child.length} chars]`;
      continue;
    }
    output[key] = sanitizeValue(child, seen);
  }
  return output;
}

function isEncryptedReasoningField(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return normalized === "encryptedcontent" || normalized === "reasoningencryptedcontent";
}

function isImagePayloadRecord(value: object): value is Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return (
    (record.type === "image" && typeof record.image === "string") ||
    ((record.type === "image-data" || record.type === "media") && typeof record.data === "string") ||
    (record.type === "file" && isInlineImageFileData(record)) ||
    (record.type === "view_image_result" && isRecord(record.image))
  );
}

function sanitizeImagePayloadRecord(value: Record<string, unknown>): Record<string, unknown> {
  if (value.type === "view_image_result") {
    return {
      ...value,
      image: sanitizeImagePayloadRecord(value.image as Record<string, unknown>)
    };
  }
  if (value.type === "file" && isRecord(value.data)) {
    return {
      ...value,
      data: sanitizeImagePayloadRecord(value.data)
    };
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((key === "image" || key === "data") && typeof child === "string") {
      output[key] = `[omitted ${base64SizeBytes(child)} byte image]`;
      continue;
    }
    output[key] = sanitizeValue(child, new WeakSet());
  }
  return output;
}

function isInlineImageFileData(record: Record<string, unknown>): boolean {
  if (typeof record.mediaType !== "string" || !record.mediaType.toLowerCase().startsWith("image/")) {
    return false;
  }
  const data = record.data;
  return isRecord(data) && data.type === "data" && typeof data.data === "string";
}

function base64SizeBytes(base64: string): number {
  const compact = base64.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(compact.length * 3 / 4) - padding);
}

function numberOrUndefined(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMetadataForLog(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  collectErrorMetadata(error, fields, new WeakSet(), 0);
  return fields;
}

function collectErrorMetadata(
  value: unknown,
  fields: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number
): void {
  if (value === null || value === undefined || depth > 6) return;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (parsed !== null) collectErrorMetadata(parsed, fields, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  const record = value as Record<string, unknown>;
  copyField(record, fields, "code", "code");
  copyField(record, fields, "type", "type");
  copyField(record, fields, "status", "status");
  copyField(record, fields, "statusCode", "status");
  copyField(record, fields, "requestId", "requestId");
  copyField(record, fields, "request_id", "requestId");
  copyField(record, fields, "param", "param");
  copyField(record, fields, "detail", "detail");

  for (const key of ["error", "cause", "body", "response", "responseBody", "data"]) {
    if (key in record) collectErrorMetadata(record[key], fields, seen, depth + 1);
  }
}

function copyField(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  sourceKey: string,
  targetKey: string
): void {
  if (target[targetKey] !== undefined) return;
  const value = source[sourceKey];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) target[targetKey] = trimmed;
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    target[targetKey] = value;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function errorNameForLog(error: unknown): string {
  const direct = isRecord(error) ? stringValue(error.name) : "";
  if (direct && direct !== "Error") return direct;
  const nested = nestedNonGenericErrorName(error, new WeakSet(), 0);
  return nested || direct;
}

function nestedNonGenericErrorName(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): string {
  if (value === null || value === undefined || depth > 6) return "";
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === null ? "" : nestedNonGenericErrorName(parsed, seen, depth + 1);
  }
  if (typeof value !== "object" || Array.isArray(value)) return "";
  if (seen.has(value)) return "";
  seen.add(value);

  const record = value as Record<string, unknown>;
  const name = stringValue(record.name);
  if (name && name !== "Error") return name;
  for (const key of ["error", "cause", "body", "response", "responseBody", "data"]) {
    const nested = nestedNonGenericErrorName(record[key], seen, depth + 1);
    if (nested) return nested;
  }
  return "";
}
