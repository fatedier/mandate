import type { Database } from "bun:sqlite";
import {
  type MemoryEntriesQuery,
  type MemoryEntriesResponse,
  type MemoryEntryDto,
  type MemoryEntrySort,
  type MemoryStatsResponse,
  type MemoryUsageBuckets
} from "../../../shared/api/memory.js";
import type { MemoryRow } from "./local-provider-helpers.js";
import { rowToEntry } from "./local-provider-helpers.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/**
 * SQL for one usage band.
 *
 * The bands split on *use*, not recall. Recall barely discriminates — in a real
 * store 92% of memories had been recalled at least once — whereas only 20% had
 * ever been used. The memories pulled into context again and again without ever
 * being leaned on are the ones costing tokens for nothing, and `idle` is
 * exactly that set.
 */
function usageClause(
  usage: MemoryEntriesQuery["usage"]
): { sql: string; params: unknown[] } | null {
  switch (usage) {
    case "used":
      return { sql: "use_count > 0", params: [] };
    case "idle":
      return { sql: "(use_count = 0 and recall_count > 0)", params: [] };
    case "untouched":
      return { sql: "(use_count = 0 and recall_count = 0)", params: [] };
    default:
      return null;
  }
}

/** Looked up rather than interpolated, so an unknown sort can't reach the SQL. */
const ORDER_BY: Record<MemoryEntrySort, string> = {
  recent: "updated_at desc",
  // "What it leans on" means most *used*, not most retrieved — the two rank
  // memories very differently.
  used: "use_count desc, last_used_at desc",
  // Ties on recall_count are common; the secondary key keeps the order stable
  // and meaningful rather than whatever SQLite happens to return.
  recalled: "recall_count desc, last_recalled_at desc",
  created: "created_at desc",
  oldest: "created_at asc"
};

export function listMemoryEntries(
  db: Database,
  query: MemoryEntriesQuery
): MemoryEntriesResponse {
  const where: string[] = [];
  const params: unknown[] = [];

  const status = query.status ?? "available";
  if (status === "available") {
    where.push("status = 'available'");
  } else if (status === "archived") {
    where.push("status = 'archived'");
  } else {
    where.push("status in ('available','archived')");
  }

  if (query.scope && query.scope !== "all") {
    where.push("scope = ?");
    params.push(query.scope);
  }
  if (query.projectId) {
    where.push("project_id = ?");
    params.push(query.projectId);
  }
  if (query.featureId) {
    where.push("feature_id = ?");
    params.push(query.featureId);
  }
  if (query.kind && query.kind !== "all") {
    where.push("kind = ?");
    params.push(query.kind);
  }
  const usage = usageClause(query.usage);
  if (usage) {
    where.push(usage.sql);
    params.push(...usage.params);
  }
  if (query.q && query.q.trim()) {
    where.push("(content like ? or cues_json like ?)");
    const like = `%${query.q.trim()}%`;
    params.push(like, like);
  }

  const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);
  const orderBy = ORDER_BY[query.sort ?? "recent"] ?? ORDER_BY.recent;

  const totalRow = db
    .prepare(`select count(*) as c from memory_entries ${whereSql}`)
    .get(...params) as { c: number };

  const rows = db
    .prepare(`
      select * from memory_entries
      ${whereSql}
      order by ${orderBy}
      limit ? offset ?
    `)
    .all(...params, limit, offset) as MemoryRow[];

  const entries: MemoryEntryDto[] = rows.map(toDto);
  return { entries, total: totalRow.c, limit, offset };
}

export function getMemoryStats(db: Database): MemoryStatsResponse {
  const usageRow = db
    .prepare(`
      select
        sum(case when use_count > 0 then 1 else 0 end) as used,
        sum(case when use_count = 0 and recall_count > 0 then 1 else 0 end) as idle,
        sum(case when use_count = 0 and recall_count = 0 then 1 else 0 end) as untouched
      from memory_entries
      where status = 'available'
    `)
    .get() as Record<keyof MemoryUsageBuckets, number | null>;

  const totalsRow = db
    .prepare(`
      select
        sum(case when status = 'available' then 1 else 0 end) as available,
        sum(case when status = 'archived' then 1 else 0 end) as archived,
        count(*) as total
      from memory_entries
      where status in ('available','archived')
    `)
    .get() as { available: number | null; archived: number | null; total: number | null };

  const scopeRows = db
    .prepare(`
      select scope, count(*) as c from memory_entries
      where status = 'available'
      group by scope
    `)
    .all() as Array<{ scope: string; c: number }>;

  const kindRows = db
    .prepare(`
      select kind, count(*) as c from memory_entries
      where status = 'available'
      group by kind
    `)
    .all() as Array<{ kind: string; c: number }>;

  const projectRows = db
    .prepare(`
      select m.project_id as projectId, coalesce(p.name, m.project_id) as name, count(*) as count
      from memory_entries m
      left join projects p on p.id = m.project_id
      where m.status = 'available' and m.project_id is not null
      group by m.project_id
      order by count desc, name asc
    `)
    .all() as Array<{ projectId: string; name: string; count: number }>;

  return {
    totals: {
      available: totalsRow.available ?? 0,
      archived: totalsRow.archived ?? 0,
      total: totalsRow.total ?? 0
    },
    byScope: indexByKey(scopeRows, "scope", ["user", "global", "project", "feature"]),
    byKind: indexByKey(kindRows, "kind", ["episodic", "semantic", "preference", "procedural"]),
    byProject: projectRows,
    usage: {
      used: usageRow.used ?? 0,
      idle: usageRow.idle ?? 0,
      untouched: usageRow.untouched ?? 0
    }
  };
}

function indexByKey<K extends string>(
  rows: Array<Record<string, unknown> & { c: number }>,
  field: string,
  keys: K[]
): Record<K, number> {
  const result = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const row of rows) {
    const key = row[field] as K;
    if (keys.includes(key)) result[key] = row.c;
  }
  return result;
}

function toDto(row: MemoryRow): MemoryEntryDto {
  const entry = rowToEntry(row);
  return {
    id: entry.id,
    scope: entry.scope,
    projectId: entry.projectId,
    featureId: entry.featureId,
    kind: entry.kind,
    status: entry.status,
    content: entry.content,
    strength: entry.strength,
    confidence: entry.confidence,
    cues: entry.cues,
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastRecalledAt: entry.lastRecalledAt,
    recallCount: entry.recallCount,
    lastUsedAt: entry.lastUsedAt,
    useCount: entry.useCount,
    feedback: entry.feedback as Record<string, number>,
    metadata: entry.metadata
  };
}
