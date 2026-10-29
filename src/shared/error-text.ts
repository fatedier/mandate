/**
 * `err instanceof Error ? err.message : String(err)` in one place: an Error's
 * own message verbatim, otherwise `fallback`, otherwise the value as a string.
 * It never digs into payloads, trims, or returns "" for a missing value — it
 * shows exactly what was thrown. (The server's formatErrorMessage is the one
 * that digs, redacts and bounds a provider's error.)
 */
export function errorText(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}
