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
  /** The run wrote its partition's brief. Absent on runs before briefs. */
  briefWritten?: boolean;
}

export type MemoryDreamPhase = "user" | "project";

/** Applied actions of a run by type. */
export type MemoryDreamActionCounts = Record<"merge" | "update" | "archive" | "move" | "split", number>;

export interface MemoryDreamActionDto {
  id: string;
  runId: string;
  actionType: string;
  status: string;
  memoryId: string;
  targetMemoryId: string | null;
  reason: string;
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
  /** The brief this run wrote, and its partition's brief before it. */
  brief: { content: string; previous: string | null } | null;
} | ApiErrorResponse;

/** A partition's brief: what every agent working there reads first. */
export interface MemoryBriefDto {
  scope: "user" | "project";
  projectId: string | null;
  projectName: string | null;
  content: string;
  builtAt: string;
  /** Entries changed since it was built: the next dream run rewrites it. */
  stale: boolean;
  /** Its size by the dream's estimate, and the limit the dream keeps it under. */
  tokens: number;
  tokenLimit: number;
}

export interface MemoryBriefsResponse {
  /** The user's brief first, then the projects' by name. */
  briefs: MemoryBriefDto[];
}

export interface MemoryEntryHistoryEvent {
  at: string;
  text: string;
  /** The reason given, when there was one. */
  detail?: string;
}

/** Where a memory came from and what happened to it since, newest first. */
export interface MemoryEntryHistoryResponse {
  events: MemoryEntryHistoryEvent[];
  /** The conversation it was learned in, when that is still known. */
  sourceThread: {
    id: string;
    scope: "manager" | "worker" | "global";
    title: string | null;
    projectSlug: string | null;
    featureSlug: string | null;
    featureName: string | null;
    /** The thread, or its worker, was archived: its page no longer opens. */
    archived: boolean;
  } | null;
}

export type MemoryDreamTriggerResult =
  | {
      skipped: true;
      reason: string;
    }
  | {
      runId: string;
      trigger: string;
      phase: MemoryDreamPhase;
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
        phase: MemoryDreamPhase;
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
  result: MemoryDreamTriggerResult;
} | ApiErrorResponse;

export interface MemoryEntryDto {
  id: string;
  scope: "user" | "project";
  projectId: string | null;
  featureId: string | null;
  type: "preference" | "knowledge" | "task";
  source: "user" | "agent" | "extraction";
  userQuote: string | null;
  status: "available" | "archived";
  content: string;
  sourceThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
}

export const MEMORY_ENTRY_SORTS = ["recent", "created", "oldest"] as const;
export type MemoryEntrySort = (typeof MEMORY_ENTRY_SORTS)[number];

export interface MemoryEntriesQuery {
  scope?: "user" | "project" | "all";
  projectId?: string;
  type?: "preference" | "knowledge" | "all";
  source?: "user" | "agent" | "extraction" | "all";
  status?: "available" | "archived" | "all";
  /** Only memories an agent forgot (archived with a reason). */
  forgotten?: boolean;
  /** Only what an agent or the user brought in: not the parts a dream split off. */
  learned?: boolean;
  /** Only memories whose last change of text was an extraction's, newest
   *  change first (the sort is then that). */
  updated?: boolean;
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

export interface MemoryStatsResponse {
  totals: { available: number; archived: number; total: number };
  byScope: { user: number; project: number };
  byType: { preference: number; knowledge: number };
  bySource: { user: number; agent: number; extraction: number };
  byProject: MemoryProjectCount[];
  /** Every project a live or archived memory refers to, by id. */
  projectNames: Record<string, string>;
}
