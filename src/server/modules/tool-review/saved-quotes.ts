import type { ToolCallSpec } from "../agent/wake-loop.js";
import type { MemoryManager } from "../memory/manager.js";

const QUERY_MAX = 500;
const QUOTES = 5;

/** The decisions the user saved in their own words that bear on a call:
 *  preferences carrying the user's quote, found by a memory search on what
 *  the call says, among the user's own and the call's project's (another
 *  project's decisions are about that project). What an agent noted, with
 *  no quote, is not the user's. */
export function savedDecisionQuotes(memory: Pick<MemoryManager, "search">): (call: ToolCallSpec, projectId: string | null) => Promise<string[]> {
  return async (call, projectId) => {
    const query = stringsIn(call.args).join(" ").slice(0, QUERY_MAX);
    if (!query.trim()) return [];
    // Both at once: none starts after the review has moved on.
    const found = (await Promise.all([
      memory.search({ query, scope: "user", type: "preference", maxResults: QUOTES * 2 }),
      projectId ? memory.search({ query, scope: "project", projectId, type: "preference", maxResults: QUOTES * 2 }) : Promise.resolve([])
    ])).flat().sort((a, b) => b.score - a.score);
    const quotes = found.flatMap((result) => (result.entry.userQuote?.trim() ? [result.entry.userQuote.trim()] : []));
    return [...new Set(quotes)].slice(0, QUOTES);
  };
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}
