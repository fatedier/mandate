import { estimateTextTokens } from "../agent/compression.js";
import type { MemoryManager } from "./manager.js";
import type { MemoryEntry } from "./types.js";

/** The memories written or changed lately, which no brief shows yet: most
 *  repeats are written within hours of what they repeat. */
export const RECENT_MEMORY_HOURS = 48;
export const RECENT_MEMORY_LIMIT = 100;
export const RECENT_MEMORY_TOKENS = 10_000;

/** The preferences and knowledge written or changed in the last
 *  RECENT_MEMORY_HOURS, newest first: the user's first, up to half the list
 *  (every window may write them, and they are few and short), then the
 *  given projects' with what is left, until RECENT_MEMORY_LIMIT memories or
 *  RECENT_MEMORY_TOKENS of their lines. In each part the first line that
 *  would pass its tokens ends that part. */
export function recentMemoriesFor(
  memory: Pick<MemoryManager, "listAvailable">,
  projects: ReadonlyArray<{ id: string; name: string }>,
  now: number
): MemoryEntry[] {
  const since = new Date(now - RECENT_MEMORY_HOURS * 3_600_000).toISOString();
  const fresh = (filter: { scope: "user" | "project"; projectId: string | null }) =>
    memory.listAvailable(filter).filter((entry) => entry.type !== "task" && entry.updatedAt >= since);
  const newestFirst = (a: MemoryEntry, b: MemoryEntry) => b.updatedAt.localeCompare(a.updatedAt);
  const listed: MemoryEntry[] = [];
  let tokens = 0;
  const take = (entries: readonly MemoryEntry[], limit: number, tokenLimit: number) => {
    for (const entry of entries) {
      if (listed.length >= limit) break;
      const cost = estimateTextTokens(recentMemoryLine(entry, projects));
      if (tokens + cost > tokenLimit) break;
      listed.push(entry);
      tokens += cost;
    }
  };
  // A pass of the dream over the user's memories can make many of them
  // recent at once: half the list stays the projects'.
  take(fresh({ scope: "user", projectId: null }).sort(newestFirst), RECENT_MEMORY_LIMIT / 2, RECENT_MEMORY_TOKENS / 2);
  take(projects.flatMap((p) => fresh({ scope: "project", projectId: p.id })).sort(newestFirst), RECENT_MEMORY_LIMIT, RECENT_MEMORY_TOKENS);
  return listed;
}

/** `- [<id>] <type>, <user | project <name>>, <YYYY-MM-DD HH:MM> UTC: <content>` */
export function recentMemoryLine(entry: MemoryEntry, projects: ReadonlyArray<{ id: string; name: string }>): string {
  const scope = entry.scope === "user" ? "user" : `project ${projects.find((p) => p.id === entry.projectId)?.name ?? entry.projectId}`;
  return `- [${entry.id}] ${entry.type}, ${scope}, ${entry.updatedAt.slice(0, 10)} ${entry.updatedAt.slice(11, 16)} UTC: ${entry.content}`;
}
