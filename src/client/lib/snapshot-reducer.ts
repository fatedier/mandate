/** Parse a Server-Sent Event's `data` field. SSE delivers raw text; we ship
 *  JSON. Reused by every listener so the cast lives in one place. */
export function parseSseData<T>(event: Event): T {
  return JSON.parse((event as MessageEvent).data) as T;
}
