import { contentSimilarity, SIMILAR_MEMORY_THRESHOLD } from "./content-similarity.js";
import { cosineSimilarity } from "./local-provider-helpers.js";
import type { MemoryEntry, MemoryListFilter } from "./types.js";

/** Embeddings this close mark two memories as possible duplicates for the
 *  dream's model to read side by side; the model decides. Set for
 *  text-embedding-3-small: pairs worth merging often have too few words alike
 *  for SIMILAR_MEMORY_THRESHOLD, and the vectors still find them. A pair that
 *  contradicts itself
 *  (one value changed, a "not" added) also scores high, and should be shown:
 *  the newer one usually records what the user decided since. */
export const SIMILAR_MEMORY_VECTOR_THRESHOLD = 0.7;

/** Two memories in one place (one scope; one project) whose words or stored
 *  embeddings are close. `vectors` holds each available memory's embedding,
 *  or is null when no embedding model is configured. */
export function arePossibleDuplicates(
  a: MemoryEntry,
  b: MemoryEntry,
  vectors: ReadonlyMap<string, ArrayLike<number>> | null
): boolean {
  if (a.scope !== b.scope || a.projectId !== b.projectId) return false;
  if (contentSimilarity(a.content, b.content) >= SIMILAR_MEMORY_THRESHOLD) return true;
  const vectorA = vectors?.get(a.id);
  const vectorB = vectors?.get(b.id);
  return vectorA !== undefined
    && vectorB !== undefined
    && cosineSimilarity(vectorA, vectorB) >= SIMILAR_MEMORY_VECTOR_THRESHOLD;
}

export type MemoryDreamPartition = { kind: "user" } | { kind: "project"; projectId: string };

/** The longest brief an agent's initial context carries, in UTF-8 bytes: the
 *  limit the dream is told. Bytes rather than an estimate of tokens: they
 *  follow a model's tokens about as closely for Chinese as for English text.
 *  write_brief refuses a brief only a tenth past it, so one
 *  written to the limit is not sent back for a few bytes over; nothing
 *  truncates. */
export const BRIEF_BYTE_LIMITS = { user: 9000, project: 6000 } as const;

/** A brief's size as it is kept. */
export function briefBytes(content: string): number {
  return Buffer.byteLength(content.trim(), "utf8");
}

export function partitionFilter(partition: MemoryDreamPartition): MemoryListFilter {
  return partition.kind === "user"
    ? { scope: "user", projectId: null }
    : { scope: "project", projectId: partition.projectId };
}

export function partitionContains(entry: MemoryEntry, partition: MemoryDreamPartition): boolean {
  return partition.kind === "user"
    ? entry.scope === "user"
    : entry.scope === "project" && entry.projectId === partition.projectId;
}

export interface DreamActionInput {
  type: "merge" | "update" | "archive" | "move" | "split";
  memoryId: string;
  reason: string;
  targetMemoryId?: string;
  content?: string;
  entryType?: "preference" | "knowledge";
  scope?: "user" | "project";
  projectId?: string;
  parts?: string[];
}

/** When the user said a memory's words: memory_update records it with their
 *  words; otherwise the memory was written when they said it. Not updatedAt,
 *  which a merge into the memory or a move rewrites. */
export function userStatedAt(entry: Pick<MemoryEntry, "createdAt" | "metadata">): string {
  const stated = entry.metadata?.statedAt;
  return typeof stated === "string" ? stated : entry.createdAt;
}

/** Why the dream may not take this action, or "" when it may: the memories
 *  must be available ones of this partition, a task record (a worker's
 *  history, not a memory) is never changed, and a move needs a real
 *  destination. Which of the user's statements holds is the prompt's to say. */
export function dreamActionRejection(
  action: DreamActionInput,
  ctx: {
    entry: MemoryEntry | null;
    target: MemoryEntry | null;
    partition: MemoryDreamPartition;
    activeProjectIds: ReadonlySet<string>;
    /** Whether an id names a worker's task record. */
    isRecord: (id: string) => boolean;
  }
): string {
  const { entry, target, partition } = ctx;
  const named = [action.memoryId, ...(action.type === "merge" && action.targetMemoryId ? [action.targetMemoryId] : [])];
  if (named.some((id) => ctx.isRecord(id))) return "task records are history and cannot be changed";
  if (!entry || entry.status !== "available" || !partitionContains(entry, partition)) {
    return "memory is not an available entry of this partition";
  }
  switch (action.type) {
    case "merge":
      if (!target || target.status !== "available" || !partitionContains(target, partition)) {
        return "merge target is not an available entry of this partition";
      }
      if (target.id === entry.id) return "merge target cannot be the memory itself";
      return "";
    case "update":
      return action.content ? "" : "update needs content";
    case "archive":
      return "";
    case "move": {
      if (!action.scope) return "move needs a scope";
      if (action.scope === "project" && (!action.projectId || !ctx.activeProjectIds.has(action.projectId))) {
        return "move needs an active projectId";
      }
      const already = action.scope === entry.scope && (action.scope === "user" || action.projectId === entry.projectId);
      return already ? "the memory is already there" : "";
    }
    case "split":
      return (action.parts?.length ?? 0) < 2 ? "split needs at least two parts" : "";
  }
}

/** Why write_brief refuses `content`, or "". A refusal says how much to cut,
 *  down to the limit itself: a retry that cuts only a sentence would be sent
 *  back again. */
export function briefRejection(content: string, partition: MemoryDreamPartition): string {
  if (!content.trim()) return "the brief is empty";
  const limit = BRIEF_BYTE_LIMITS[partition.kind];
  const bytes = briefBytes(content);
  if (bytes <= limit + limit / 10) return "";
  const cut = Math.min(99, Math.ceil(((bytes - limit) / bytes) * 100));
  return `${bytes} bytes, the limit is ${limit}: cut about ${cut}% of it (to about ${limit} bytes) and write it again.`;
}
