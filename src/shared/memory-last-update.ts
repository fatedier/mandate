/** The last change of a memory's text, as its metadata keeps it: the version
 *  it replaced (one back), when, and the extraction that made it when one
 *  did. Null when none is kept. */
export interface MemoryLastUpdate {
  /** `asLearned`: this version is the text the memory was learned with. */
  previous: { content: string; updatedAt: string; asLearned: boolean };
  at: string;
  byExtraction: string | null;
  /** What the change added after the old text, when it kept that text whole. */
  added: string | null;
}

interface WithText {
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

/** The version a change replaced, as the store keeps it (local-provider.ts). */
interface KeptVersion {
  content: string;
  updatedAt: string;
  replacedAt: string;
  asLearned?: true;
}

export function memoryLastUpdate(entry: WithText): MemoryLastUpdate | null {
  const kept = entry.metadata?.previous as KeptVersion | undefined;
  if (!kept) return null;
  const { content, updatedAt, replacedAt, asLearned } = kept;
  const byExtraction = entry.metadata?.updatedByExtraction;
  const added = content && entry.content.startsWith(content) ? entry.content.slice(content.length).trim() : "";
  return {
    previous: { content, updatedAt, asLearned: asLearned === true },
    at: replacedAt,
    byExtraction: typeof byExtraction === "string" ? byExtraction : null,
    added: added || null
  };
}

/** The memory as it was learned: the version kept, when the store knew it
 *  for the one it was learned as (its text changed once since); otherwise
 *  its text now. */
export function memoryTextAsLearned(entry: WithText): string {
  const last = memoryLastUpdate(entry);
  return last?.previous.asLearned ? last.previous.content : entry.content;
}

/** A memory's metadata without what the store keeps for the Memory page
 *  alone: the version a change replaced (and the user's words in it) is not
 *  for a model to read back. */
export function withoutKeptVersion(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return metadata;
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "previous" && key !== "textAsLearned"));
}
