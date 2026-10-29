import { cacheFamilyOf } from "../../../../shared/llm-api.js";
import type { WakeLlmCandidate } from "../wake-llm-attempts.js";

/** Mandate asks Claude for a one-hour cache (its marks and the seal). */
export const CLAUDE_CACHE_LIFETIME_MINUTES = 60;
/** GPT's default prompt cache on OpenAI (GPT-5.6 and later), and Azure's only. */
export const GPT_CACHE_LIFETIME_MINUTES = 30;

/**
 * How many minutes a model's provider keeps a cached prompt after its last
 * use, for idle compaction: the lifetime typed for the model, or its
 * family's default — a model that runs as the Anthropic family 60, OpenAI's
 * own models 30, any other 0 (off). A Claude model never gets more than the
 * hour Mandate asks for: a longer one would compact on a cold cache.
 */
export function idleCacheLifetimeMinutes(meta: WakeLlmCandidate["meta"], typed: number | undefined): number {
  const family = cacheFamilyOf(meta?.provider, meta?.model ?? "");
  if (typed !== undefined) return family === "claude" ? Math.min(typed, CLAUDE_CACHE_LIFETIME_MINUTES) : typed;
  if (family === "claude") return CLAUDE_CACHE_LIFETIME_MINUTES;
  return family === "gpt" ? GPT_CACHE_LIFETIME_MINUTES : 0;
}

/** A thread an idle compaction may run on: it exists, is not archived, and
 *  is not a worker whose feature is archived (a retired worker). */
export function isCompactableThread(thread: { archivedAt: string | null; scope: string } | null, featureArchived: boolean): boolean {
  if (!thread || thread.archivedAt) return false;
  return !(thread.scope === "worker" && featureArchived);
}
