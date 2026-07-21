export const CODEX_USER_AGENT = "Mandate/0.1.0";

export function withCodexUserAgent(input: HeadersInit | undefined) {
  const headers = headersFrom(input);
  headers.set("User-Agent", CODEX_USER_AGENT);
  return headers;
}

function headersFrom(input: HeadersInit | undefined) {
  const headers = new Headers();
  if (!input) return headers;
  if (input instanceof Headers) {
    input.forEach((value, key) => headers.set(key, value));
    return headers;
  }
  if (Array.isArray(input)) {
    for (const [key, value] of input) {
      headers.set(key, value);
    }
    return headers;
  }
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) headers.set(key, value);
  }
  return headers;
}
