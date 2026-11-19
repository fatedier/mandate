import type { Context } from "hono";

/** What readJsonBody answers for a body that is not JSON (or is missing). */
export const INVALID_JSON = Symbol("invalid-json");

/** The request's body as JSON, or INVALID_JSON. Each route says what that
 *  means for it: most answer 400, a few treat it as an empty body. */
export async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return INVALID_JSON;
  }
}
