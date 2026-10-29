import type {
  MemoryEntry,
  MemoryListFilter,
  MemoryScope,
  MemorySearchInput,
  MemorySearchReason,
  MemorySource,
  MemoryStatus,
  MemoryType
} from "./types.js";
import type { SqlValue } from "../../platform/db/sql-value.js";
import { parseJsonRecord } from "../../platform/json.js";

export type MemoryRow = {
  id: string;
  scope: MemoryScope;
  project_id: string | null;
  feature_id: string | null;
  type: MemoryType;
  source: MemorySource;
  user_quote: string | null;
  content: string;
  status: MemoryStatus;
  source_thread_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
};

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

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
    type: row.type,
    source: row.source,
    userQuote: row.user_quote,
    content: row.content,
    status: row.status,
    sourceThreadId: row.source_thread_id,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJsonRecord(row.metadata_json)
  };
}

export function buildSearchFilter(input: MemorySearchInput, alias: string) {
  const params: SqlValue[] = [];
  const clauses: string[] = [];
  if (!input.includeArchived) clauses.push(`${alias}.status = 'available'`);
  if (input.type) {
    clauses.push(`${alias}.type = ?`);
    params.push(input.type);
  }
  if (input.types?.length) {
    clauses.push(`${alias}.type in (${input.types.map(() => "?").join(", ")})`);
    params.push(...input.types);
  }
  if (input.projectId) {
    clauses.push(`${alias}.scope = 'project' and ${alias}.project_id = ?`);
    params.push(input.projectId);
  } else if (input.scope === "user" || input.scope === "project") {
    clauses.push(`${alias}.scope = ?`);
    params.push(input.scope);
  }
  return {
    where: clauses.length ? `and ${clauses.join(" and ")}` : "",
    params
  };
}

export function buildListFilter(filter: MemoryListFilter, alias: string) {
  const clauses = [`${alias}.scope = ?`];
  const params: SqlValue[] = [filter.scope];
  if (filter.scope === "project") {
    clauses.push(`${alias}.project_id = ?`);
    params.push(filter.projectId ?? "");
  }
  if (filter.type) {
    clauses.push(`${alias}.type = ?`);
    params.push(filter.type);
  }
  return { where: clauses.join(" and "), params };
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
