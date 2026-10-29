const PLACEHOLDER_OBJECT_MESSAGE = "[object Object]";
const DEFAULT_ERROR_MESSAGE = "The agent failed. Please try again.";
const UNREADABLE_PROVIDER_ERROR = "Model provider returned an unreadable error. Please retry.";
const MAX_VISIBLE_ERROR_LENGTH = 180;

export function formatUserFacingError(input: string | null | undefined): string {
  const message = extractErrorMessage(input);
  return conciseErrorMessage(message) || DEFAULT_ERROR_MESSAGE;
}

/**
 * The readable message inside whatever an error turned out to be, or "" when
 * there is none — unlike formatUserFacingError, which always produces
 * something to show. Callers that decide *whether* to render an error block
 * need to be able to get nothing back.
 */
export function extractErrorMessage(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return extractErrorString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value !== "object") return String(value);
  return extractErrorRecord(value as Record<string, unknown>);
}

function extractErrorString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = parseJson(trimmed);
  if (parsed !== null) {
    const parsedMessage = extractErrorMessage(parsed);
    if (parsedMessage) return parsedMessage;
  }
  if (trimmed === PLACEHOLDER_OBJECT_MESSAGE) {
    return UNREADABLE_PROVIDER_ERROR;
  }
  const firstLine = trimmed.split(/\n\s*at\s+/)[0]?.trim() ?? trimmed;
  return firstLine || trimmed;
}

function extractErrorRecord(record: Record<string, unknown>): string {
  const nested = record.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedMessage = extractErrorRecord(nested as Record<string, unknown>);
    if (nestedMessage) return nestedMessage;
  }

  for (const key of ["message", "detail", "details", "reason", "body", "responseBody", "data"]) {
    if (!(key in record)) continue;
    const message = extractErrorMessage(record[key]);
    if (message && message !== PLACEHOLDER_OBJECT_MESSAGE) return message;
  }

  if (record.stack && record.message === PLACEHOLDER_OBJECT_MESSAGE) {
    return UNREADABLE_PROVIDER_ERROR;
  }

  const status = stringField(record, "status") || stringField(record, "statusCode") || stringField(record, "code");
  if (status) return `Request failed (${status}).`;
  return "";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function parseJson(value: string): unknown | null {
  if (!value.startsWith("{") && !value.startsWith("[")) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function conciseErrorMessage(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned === PLACEHOLDER_OBJECT_MESSAGE) return UNREADABLE_PROVIDER_ERROR;

  return cleaned.length > MAX_VISIBLE_ERROR_LENGTH
    ? `${cleaned.slice(0, MAX_VISIBLE_ERROR_LENGTH).trimEnd()}...`
    : cleaned;
}
