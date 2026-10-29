export type MemoryScope = "user" | "project";
export type MemoryType = "preference" | "knowledge" | "task";
export type MemorySource = "user" | "agent" | "extraction";
export type MemoryStatus = "available" | "archived";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  /** The worker it came from: always set on a task record, otherwise when it
   *  was written inside a worker. Provenance only; it scopes nothing. */
  featureId: string | null;
  type: MemoryType;
  source: MemorySource;
  /** The user's words, checked against the thread's user messages, when
   *  source is "user" and the words were kept; null otherwise. */
  userQuote: string | null;
  content: string;
  status: MemoryStatus;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
}

export interface MemorySearchInput {
  query: string;
  /** "all" (the default) searches the user scope and every project. */
  scope?: MemoryScope | "all";
  /** One project's memories only. */
  projectId?: string | null;
  type?: MemoryType | null;
  /** Only these types; none listed, any type. */
  types?: readonly MemoryType[];
  includeArchived?: boolean;
  maxResults?: number;
}

export type MemorySearchReason = "fts" | "like" | "vector";

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  reason: MemorySearchReason;
}

export interface MemoryRememberInput {
  scope: MemoryScope;
  projectId?: string | null;
  featureId?: string | null;
  type: MemoryType;
  source: MemorySource;
  userQuote?: string | null;
  content: string;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryUpdateInput {
  id: string;
  scope?: MemoryScope;
  projectId?: string | null;
  type?: MemoryType;
  source?: MemorySource;
  userQuote?: string | null;
  content?: string;
  status?: MemoryStatus;
  metadata?: Record<string, unknown> | null;
  /** Where the memory's words come from, when an update carries the user's new ones. */
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  /** The extraction that rewrites the text, marked on the memory until its
   *  text changes again. */
  byExtraction?: string;
}

export interface MemoryListFilter {
  scope: MemoryScope;
  projectId: string | null;
  type?: MemoryType;
}

export interface MemoryBrief {
  scope: MemoryScope;
  projectId: string | null;
  content: string;
  inputDigest: string;
  builtAt: string;
  runId: string | null;
}

/** Writes inside MemoryProvider.writeIfUnchanged: synchronous, in its transaction. */
export interface MemoryWriteTx {
  update(input: MemoryUpdateInput): MemoryEntry;
  archive(id: string, metadata?: Record<string, unknown>): MemoryEntry;
  remember(input: MemoryRememberInput): MemoryEntry;
}

/** How a memory was used:
 *  - search: a memory search handed it to an agent (rank: its place, 1 first);
 *  - read: an agent opened it by id;
 *  - restated: an extraction named it as what its conversation says again
 *    (rewritten in place, or sent back unchanged);
 *  - repeat: an extraction left a new memory out as a repeat of one of the
 *    stored memories it was compared with, which one unknown (rank: how
 *    alike, 1 the most). */
export type MemoryUseKind = "search" | "read" | "restated" | "repeat";

export interface MemoryUse {
  memoryId: string;
  kind: MemoryUseKind;
  /** The conversation it was used in. */
  threadId: string | null;
  /** The agent that used it (worker, manager, global, subagent); null when
   *  the conversation's own kind is not at hand (an extraction). */
  agent: string | null;
  rank?: number | null;
}

export interface MemoryProvider {
  remember(input: MemoryRememberInput): Promise<MemoryEntry>;
  update(input: MemoryUpdateInput): Promise<MemoryEntry | null>;
  archive(id: string, metadata?: Record<string, unknown>): Promise<MemoryEntry | null>;
  /** All of `write`, or nothing when a memory in `expected` is no longer
   *  available at that version; null then. */
  writeIfUnchanged<T>(expected: ReadonlyArray<Pick<MemoryEntry, "id" | "updatedAt">>, write: (tx: MemoryWriteTx) => T): Promise<T | null>;
  get(id: string): Promise<MemoryEntry | null>;
  search(input: MemorySearchInput): Promise<MemorySearchResult[]>;
  listAvailable(filter: MemoryListFilter): MemoryEntry[];
  listArchivedSince(filter: MemoryListFilter, sinceIso: string): MemoryEntry[];
  /** Each available memory's stored embedding by id, or null when no embedding
   *  model is configured. The arrays are shared with the search cache: read only. */
  availableVectors(): ReadonlyMap<string, Float64Array> | null;
  getBrief(scope: MemoryScope, projectId: string | null): MemoryBrief | null;
  putBrief(brief: MemoryBrief): void;
  deleteBrief(scope: MemoryScope, projectId: string | null): void;
  listBriefs(): MemoryBrief[];
  recordUses(uses: readonly MemoryUse[]): void;
}
