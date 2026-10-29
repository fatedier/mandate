import { isRecord } from "../../shared/guards.js";

/** Parses a stored JSON column. Empty or unparseable input reads as null. */
export function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** A JSON column that should hold a plain object; anything else reads as null. */
export function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : null;
}

/** A JSON column that should hold a list of strings. Non-string items are
 *  dropped; anything that is not an array reads as empty. */
export function parseJsonStringArray(value: string | null | undefined): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

/** Parses free text only when it looks like a JSON object or array — for
 *  payloads embedded in error messages, where a bare word or number that
 *  happens to be valid JSON is prose, not data. */
export function parseJsonObjectOrArray(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  return parseJson(trimmed);
}
