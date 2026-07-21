import type { Database } from "bun:sqlite";
import { nowIso } from "../../platform/time/time.js";
import type {
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemorySearchContext,
  MemorySearchInput,
  MemorySearchReason,
  MemoryStatus
} from "./types.js";

export type MemoryRow = {
  id: string;
  scope: MemoryScope;
  project_id: string | null;
  feature_id: string | null;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus;
  strength: number;
  confidence: number;
  cues_json: string | null;
  source: MemoryEntry["source"];
  source_thread_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
  last_recalled_at: string | null;
  recall_count: number;
  last_used_at: string | null;
  use_count: number;
  feedback_json: string | null;
  expires_at: string | null;
  supersedes: string | null;
  metadata_json: string | null;
};

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

function resolveStatusFilter(input: MemorySearchInput): MemoryStatus | "any" {
  return input.status ?? (input.includeArchived ? "any" : "available");
}

/**
 * Whether a search admits rows the default view hides.
 *
 * The vector lane keeps only visible vectors resident, so it has to know when
 * a query reaches past them and load the rest. Sharing `resolveStatusFilter`
 * with the WHERE clause above is the point: if the two ever disagreed, an
 * archived row would come back from SQL with no vector to score it against and
 * would drop out of the semantic lane silently, leaving only the lexical one.
 */
export function admitsHiddenStatuses(input: MemorySearchInput): boolean {
  const status = resolveStatusFilter(input);
  if (status === "any") return Boolean(input.includeArchived);
  return status === "archived" || status === "deleted";
}

export function buildVisibilityFilter(
  input: MemorySearchInput,
  context: MemorySearchContext,
  alias: string
) {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const status = resolveStatusFilter(input);
  if (status !== "any") {
    clauses.push(`${alias}.status = ?`);
    params.push(status);
  } else if (!input.includeArchived) {
    clauses.push(`${alias}.status not in ('archived','deleted')`);
  }
  if (input.kind) {
    clauses.push(`${alias}.kind = ?`);
    params.push(input.kind);
  }

  const projectId = input.projectId ?? context.projectId ?? null;
  const featureId = input.featureId ?? context.featureId ?? null;
  const scope = input.scope ?? "all";
  if (scope === "all") {
    const visible = [`${alias}.scope in ('user','global')`];
    if (projectId) {
      visible.push(`(${alias}.scope = 'project' and ${alias}.project_id = ?)`);
      params.push(projectId);
    }
    if (featureId) {
      visible.push(`(${alias}.scope = 'feature' and ${alias}.feature_id = ?)`);
      params.push(featureId);
    } else if (projectId) {
      visible.push(`(${alias}.scope = 'feature' and ${alias}.project_id = ?)`);
      params.push(projectId);
    }
    clauses.push(`(${visible.join(" or ")})`);
  } else {
    clauses.push(`${alias}.scope = ?`);
    params.push(scope);
    if (scope === "project" || scope === "feature") {
      const scopedProjectId = input.projectId ?? context.projectId ?? null;
      if (scopedProjectId) {
        clauses.push(`${alias}.project_id = ?`);
        params.push(scopedProjectId);
      }
    }
    if (scope === "feature") {
      const scopedFeatureId = input.featureId ?? context.featureId ?? null;
      if (scopedFeatureId) {
        clauses.push(`${alias}.feature_id = ?`);
        params.push(scopedFeatureId);
      }
    }
  }

  return {
    where: clauses.length ? `and ${clauses.join(" and ")}` : "",
    params
  };
}

export function buildPromptVisibilityFilter(context: MemorySearchContext, alias: string) {
  const params: unknown[] = [];
  const visible = [`${alias}.scope in ('user','global')`];
  if (context.projectId) {
    visible.push(`(${alias}.scope = 'project' and ${alias}.project_id = ?)`);
    params.push(context.projectId);
  }
  if (context.featureId) {
    visible.push(`(${alias}.scope = 'feature' and ${alias}.feature_id = ?)`);
    params.push(context.featureId);
  }
  return {
    where: `and (${visible.join(" or ")})`,
    params
  };
}

export function buildFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 12);
  return tokens.map((token) => `${token.replace(/"/g, "")}*`).join(" OR ");
}

export function boundedLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(parsed)));
}

export function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    featureId: row.feature_id,
    kind: row.kind,
    content: row.content,
    status: row.status,
    strength: row.strength,
    confidence: row.confidence,
    cues: parseStringArray(row.cues_json),
    source: row.source,
    sourceThreadId: row.source_thread_id,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecalledAt: row.last_recalled_at,
    recallCount: row.recall_count,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    feedback: parseFeedbackCounts(row.feedback_json),
    expiresAt: row.expires_at,
    supersedes: row.supersedes,
    metadata: parseJsonObject(row.metadata_json)
  };
}

export function markRecalled(db: Database, ids: string[]) {
  const now = nowIso();
  const stmt = db.prepare(`
    update memory_entries set
      recall_count = recall_count + 1,
      last_recalled_at = ?,
      updated_at = updated_at
    where id = ?
  `);
  for (const id of ids) stmt.run(now, id);
}

/** Fixed precedence for an entry that two paths ranked equally well. Also the
 *  order the paths run in, so the tie-break reads the same way the code does.
 *
 *  "like" is unreachable from `search()` today: it fuses two lists, "fts" and
 *  "vector", and a substring hit rides the "fts" list and is relabelled "like"
 *  after fusion. The entry stays because it is what makes that relabel legal --
 *  "like" ranks below both, so an entry some other path also found never loses its
 *  path to it. A caller fusing a genuine "like" list still gets the same order. */
const PATH_PRECEDENCE: MemorySearchReason[] = ["fts", "vector", "like"];

/** Reciprocal Rank Fusion. Each list must be ordered by relevance; an entry's
 *  score is the sum of 1 / (k + rank) over the lists that contain it, so an entry
 *  two paths agree on outranks one that a single path put first.
 *
 *  The point of fusing by rank rather than by score is that bm25 and cosine never
 *  have to be converted onto a common scale -- there is no constant to calibrate
 *  against a corpus, only k, which sets how much rank position matters against
 *  multi-path agreement. */
export function fuseByRank(
  lists: Array<{ path: MemorySearchReason; ids: string[] }>,
  // Every score `search()` returns now comes from this function, so k is the only
  // place the curve is set. It has no counterpart to stay in step with.
  k = 60
): Map<string, { score: number; path: MemorySearchReason }> {
  const fused = new Map<string, { score: number; path: MemorySearchReason; bestRank: number }>();
  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const rank = index + 1;
      const current = fused.get(id);
      if (!current) {
        fused.set(id, { score: 1 / (k + rank), path: list.path, bestRank: rank });
        return;
      }
      current.score += 1 / (k + rank);
      const better = rank < current.bestRank;
      const tied = rank === current.bestRank
        && PATH_PRECEDENCE.indexOf(list.path) < PATH_PRECEDENCE.indexOf(current.path);
      if (better || tied) {
        current.path = list.path;
        current.bestRank = rank;
      }
    });
  }
  const scores = new Map<string, { score: number; path: MemorySearchReason }>();
  for (const [id, entry] of fused) scores.set(id, { score: entry.score, path: entry.path });
  return scores;
}

export function clamp01(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function jsonOrNull(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return JSON.stringify(value);
}

export function parseVector(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const vector = parsed.map((item) => Number(item));
    return validVector(vector) ? vector : null;
  } catch {
    return null;
  }
}

export function validVector(vector: number[]) {
  return vector.length > 0 && vector.every((value) => Number.isFinite(value));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export function mergeMetadata(
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...(existing ?? {}), ...patch };
}

export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseFeedbackCounts(value: string | null): MemoryEntry["feedback"] {
  const parsed = parseJsonObject(value);
  if (!parsed) return {};
  const result: MemoryEntry["feedback"] = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (!["used", "helpful", "irrelevant", "stale", "wrong"].includes(key)) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      result[key as keyof MemoryEntry["feedback"]] = Math.floor(value);
    }
  }
  return result;
}

export function jsonArrayOrNull(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return strings.length > 0 ? JSON.stringify(Array.from(new Set(strings))) : null;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
