// Helpers for treating URL search params as the source of truth for view
// state (filters, sort, etc.). Defaults are omitted from the URL so the URL
// stays clean — `?filter=all` would just be no param at all.

export function readEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = params.get(key);
  return (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
}

export function readString(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return value === null || value === "" ? null : value;
}

export function withParam(
  base: URLSearchParams,
  key: string,
  value: string | null | undefined
): URLSearchParams {
  const next = new URLSearchParams(base);
  if (value === null || value === undefined || value === "") {
    next.delete(key);
  } else {
    next.set(key, value);
  }
  return next;
}
