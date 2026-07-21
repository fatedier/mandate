export type MemoryScope = "user" | "global" | "project" | "feature";
export type MemoryKind = "episodic" | "semantic" | "preference" | "procedural";
export type MemoryStatus = "available" | "archived" | "deleted";
export type MemorySource = "explicit_user" | "agent_flush" | "tool_result" | "manual";
export type MemoryFeedbackOutcome = "used" | "helpful" | "irrelevant" | "stale" | "wrong";
export type MemoryFeedbackCounts = Partial<Record<MemoryFeedbackOutcome, number>>;

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  featureId: string | null;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus;
  strength: number;
  confidence: number;
  cues: string[];
  source: MemorySource;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
  lastUsedAt: string | null;
  useCount: number;
  feedback: MemoryFeedbackCounts;
  expiresAt: string | null;
  supersedes: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MemorySearchContext {
  projectId?: string | null;
  featureId?: string | null;
  threadId?: string | null;
}

export interface MemorySearchInput {
  query: string;
  /**
   * Whether this search counts as recalling the memories it returns.
   *
   * Defaults to true, because a search is normally an agent asking for
   * memories it may use. Internal lookups — deduplicating an extraction
   * against what is already stored — must pass false: they are bookkeeping,
   * and counting them inflates `recallCount` for exactly the memories most
   * similar to whatever is being written, which is a signal that the topic is
   * active, not that the memory deserves attention.
   */
  recordRecall?: boolean;
  scope?: MemoryScope | "all";
  projectId?: string | null;
  featureId?: string | null;
  kind?: MemoryKind | null;
  status?: MemoryStatus | "any";
  includeArchived?: boolean;
  maxResults?: number;
}

export type MemorySearchReason = "fts" | "like" | "vector" | "recent";

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  reason: MemorySearchReason;
}

export interface MemoryRememberInput {
  scope: MemoryScope;
  projectId?: string | null;
  featureId?: string | null;
  kind: MemoryKind;
  content: string;
  status?: MemoryStatus;
  strength?: number;
  confidence?: number;
  cues?: string[];
  source: MemorySource;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  expiresAt?: string | null;
  supersedes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryUpdateInput {
  id: string;
  scope?: MemoryScope;
  projectId?: string | null;
  featureId?: string | null;
  content?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  strength?: number;
  confidence?: number;
  cues?: string[];
  expiresAt?: string | null;
  supersedes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryFeedbackInput {
  id: string;
  outcome: MemoryFeedbackOutcome;
  note: string;
  threadId?: string | null;
  wakeId?: string | null;
}

export interface MemoryProvider {
  remember(input: MemoryRememberInput): Promise<MemoryEntry>;
  update(input: MemoryUpdateInput): Promise<MemoryEntry | null>;
  feedback(input: MemoryFeedbackInput): Promise<MemoryEntry | null>;
  get(id: string): Promise<MemoryEntry | null>;
  search(input: MemorySearchInput, context?: MemorySearchContext): Promise<MemorySearchResult[]>;
  archive(id: string, metadata?: Record<string, unknown>): Promise<MemoryEntry | null>;
  forget(id: string, metadata?: Record<string, unknown>): Promise<MemoryEntry | null>;
  listForPrompt(context: MemorySearchContext, limit?: number): Promise<MemoryEntry[]>;
}
