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
  appliedCount: number;
  actionCount: number | null;
  actionCounts: MemoryDreamActionCounts;
  rejectedCount: number | null;
  finishReason: string | null;
  error: unknown;
  metadata: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
  /** Count of available memory entries snapshotted at run start. */
  availableCountBefore: number;
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
  /** Its size in UTF-8 bytes, and the limit the dream is told to keep it under. */
  bytes: number;
  byteLimit: number;
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
    scope: "manager" | "worker" | "personal";
    title: string | null;
    projectSlug: string | null;
    workerSlug: string | null;
    workerName: string | null;
    /** The thread, or its worker, was archived: its page no longer opens. */
    archived: boolean;
  } | null;
}

export type MemoryDreamTriggerResponse = { ok: true } | ApiErrorResponse;

export interface MemoryEntryDto {
  id: string;
  scope: "user" | "project";
  projectId: string | null;
  workerId: string | null;
  type: "preference" | "knowledge";
  source: "user" | "agent" | "extraction";
  userQuote: string | null;
  status: "available" | "archived";
  content: string;
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
  byProject: MemoryProjectCount[];
  /** Every project a live or archived memory refers to, by id. */
  projectNames: Record<string, string>;
}
