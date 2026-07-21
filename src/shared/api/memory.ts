import type { ApiErrorResponse } from "./common.js";

export interface MemoryDreamRunDto {
  id: string;
  trigger: string;
  status: string;
  provider: string;
  model: string;
  phase: MemoryDreamPhase;
  projectId: string | null;
  projectName: string | null;
  candidateCount: number;
  appliedCount: number;
  actionCount: number | null;
  actionCounts: MemoryDreamActionCounts;
  rejectedCount: number | null;
  failedCount: number | null;
  finishReason: string | null;
  error: unknown;
  metadata: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
  /** Count of available memory entries snapshotted at run start. Null for
   *  pre-2026-05-21 runs that didn't record this. */
  availableCountBefore: number | null;
  /** Count of available memory entries snapshotted at run finish. */
  availableCountAfter: number | null;
}

export type MemoryDreamPhase = "global" | "project" | "legacy";

export interface MemoryDreamActionCounts {
  keep: number;
  update: number;
  merge: number;
  archive: number;
  rescope: number;
}

export interface MemoryDreamActionDto {
  id: string;
  runId: string;
  actionType: string;
  status: string;
  memoryId: string;
  targetMemoryId: string | null;
  reason: string;
  confidence: number | null;
  source: unknown;
  error: unknown;
  before: unknown;
  after: unknown;
  createdAt: string;
  appliedAt: string | null;
}

export interface MemoryDreamRunsResponse {
  runs: MemoryDreamRunDto[];
}

export type MemoryDreamRunDetailResponse = {
  run: MemoryDreamRunDto;
  actions: MemoryDreamActionDto[];
} | ApiErrorResponse;

type MemoryDreamTriggerResultDto =
  | {
      skipped: true;
      reason: string;
    }
  | {
      runId: string;
      trigger: string;
      phase: Exclude<MemoryDreamPhase, "legacy">;
      projectId: string | null;
      processed: boolean;
      candidateCount: number;
      actionCount: number;
      appliedCount: number;
      rejectedCount: number;
      failedCount: number;
      runCount?: number;
      runIds?: string[];
      partitions?: Array<{
        runId: string;
        trigger: string;
        phase: Exclude<MemoryDreamPhase, "legacy">;
        projectId: string | null;
        processed: boolean;
        candidateCount: number;
        actionCount: number;
        appliedCount: number;
        rejectedCount: number;
        failedCount: number;
      }>;
    };

export type MemoryDreamTriggerResponse = {
  ok: true;
  result: MemoryDreamTriggerResultDto;
} | ApiErrorResponse;

export interface MemoryEntryDto {
  id: string;
  scope: "user" | "global" | "project" | "feature";
  projectId: string | null;
  featureId: string | null;
  kind: "episodic" | "semantic" | "preference" | "procedural";
  status: "available" | "archived" | "deleted";
  content: string;
  strength: number;
  confidence: number;
  cues: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
  lastUsedAt: string | null;
  useCount: number;
  feedback: Record<string, number>;
  metadata: Record<string, unknown> | null;
}

/**
 * Usage bands.
 *
 * Recall and use are separate counters and they disagree sharply: a memory is
 * *recalled* when it is retrieved into an agent's context, and *used* when the
 * agent actually leans on it. In a real store 92% had been recalled but only
 * 20% ever used — so recall alone says almost nothing, while the gap between
 * them is the whole signal. `idle` is that gap: retrieved repeatedly, never
 * once useful, paying context on every recall.
 */
export const MEMORY_USAGE_FILTERS = ["all", "used", "idle", "untouched"] as const;
export type MemoryUsageFilter = (typeof MEMORY_USAGE_FILTERS)[number];

export const MEMORY_ENTRY_SORTS = ["recent", "used", "recalled", "created", "oldest"] as const;
export type MemoryEntrySort = (typeof MEMORY_ENTRY_SORTS)[number];

export interface MemoryEntriesQuery {
  scope?: "user" | "global" | "project" | "feature" | "all";
  projectId?: string;
  featureId?: string;
  kind?: "episodic" | "semantic" | "preference" | "procedural" | "all";
  status?: "available" | "archived" | "all";
  /** Usage band — the Overview's doorways land here. */
  usage?: MemoryUsageFilter;
  sort?: MemoryEntrySort;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryEntriesResponse {
  entries: MemoryEntryDto[];
  total: number;
  limit: number;
  offset: number;
}

interface MemoryProjectCount {
  projectId: string;
  name: string;
  count: number;
}

/**
 * Available memories split by usage. The three bands sum to
 * `totals.available`.
 *
 * There was a fourth, `stale` — idle and older than 90 days — meant to feed a
 * bulk-archive button. It was cut on both counts: the oldest memory in a real
 * store was 77 days old, so the band was permanently zero, and archiving is
 * maintenance's job, not a chore to hand back to the user.
 */
export interface MemoryUsageBuckets {
  /** Leaned on at least once. */
  used: number;
  /** Retrieved into context, never actually used — the dead weight. */
  idle: number;
  /** Never even retrieved. */
  untouched: number;
}

export interface MemoryStatsResponse {
  totals: { available: number; archived: number; total: number };
  byScope: { user: number; global: number; project: number; feature: number };
  byKind: { episodic: number; semantic: number; preference: number; procedural: number };
  byProject: MemoryProjectCount[];
  usage: MemoryUsageBuckets;
}
