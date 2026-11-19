/**
 * Read a JSON API response, throwing the server's own error message.
 *
 * Supports HTTP failures, `{ ok: false }`, and the chat API's `{ error }`
 * envelope. An explicit `ok: true` preserves status payloads that carry an
 * error as data, such as a failed login attempt. The caller owns UI effects.
 */
export async function readJson<T>(res: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (error) {
    // Preserve aborts and body-stream failures for the caller to handle.
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(res.ok ? "Invalid JSON response" : `HTTP ${res.status}`);
  }
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const failed = envelope?.ok === false ||
    (envelope && envelope.ok !== true && Object.hasOwn(envelope, "error"));
  if (!res.ok || failed) {
    const message = envelope?.error;
    throw new Error(typeof message === "string" && message.trim()
      ? message
      : res.ok ? "Request failed" : `HTTP ${res.status}`);
  }
  if (!payload || typeof payload !== "object") throw new Error("Invalid API response");
  return payload as T;
}
