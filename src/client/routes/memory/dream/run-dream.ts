import { api } from "@/lib/api-paths";

/** What a refused Run now says: the server refuses (400) while the memory
 *  dream is off or has no model. */
export const DREAM_REFUSED = "Memory dream is off or not set up.";

/** Runs a dream now, for both Run now buttons: resolves once it ran (null),
 *  or with DREAM_REFUSED when the server refused to start one. Any other
 *  failure (the run itself, or a proxy that stopped waiting) throws with the
 *  server's words. */
export async function runDreamNow(): Promise<string | null> {
  const res = await fetch(api.memoryDreamRuns, { method: "POST" });
  if (res.ok) return null;
  if (res.status === 400) return DREAM_REFUSED;
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  throw new Error(typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}`);
}
