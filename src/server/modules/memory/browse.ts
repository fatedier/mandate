import type { Database } from "bun:sqlite";
import {
  type MemoryBriefsResponse,
  type MemoryEntriesQuery,
  type MemoryEntriesResponse,
  type MemoryEntryDto,
  type MemoryEntryHistoryEvent,
  type MemoryEntryHistoryResponse,
  type MemoryEntrySort,
  type MemoryStatsResponse
} from "../../../shared/api/memory.js";
import type { MemoryRow } from "./local-provider-helpers.js";
import { rowToEntry } from "./local-provider-helpers.js";
import type { SqlValue } from "../../platform/db/sql-value.js";
import { parseJsonRecord } from "../../platform/json.js";
import { estimateTextTokens } from "../agent/compression.js";
import { entriesDigest, listBriefs } from "./briefs.js";
import { BRIEF_TOKEN_LIMITS } from "./dream-rules.js";
import { memoryLastUpdate } from "../../../shared/memory-last-update.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Looked up rather than interpolated, so an unknown sort can't reach the SQL. */
const ORDER_BY: Record<MemoryEntrySort, string> = {
  recent: "updated_at desc",
  created: "created_at desc",
  oldest: "created_at asc"
};

export function listMemoryEntries(
  db: Database,
  query: MemoryEntriesQuery
): MemoryEntriesResponse {
  const where: string[] = [];
  const params: SqlValue[] = [];

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
  if (query.type && query.type !== "all") {
    where.push("type = ?");
    params.push(query.type);
  }
  if (query.source && query.source !== "all") {
    where.push("source = ?");
    params.push(query.source);
  }
  if (query.forgotten) {
    where.push("json_extract(metadata_json, '$.forgottenReason') is not null");
  }
  if (query.learned) {
    where.push("json_extract(metadata_json, '$.splitFrom') is null");
  }
  // Only a change kept with its time: one kept before may be older than the last.
  if (query.updated) {
    where.push("json_extract(metadata_json, '$.updatedByExtraction') is not null");
    where.push("json_extract(metadata_json, '$.previous.replacedAt') is not null");
  }
  if (query.q && query.q.trim()) {
    where.push("content like ?");
    params.push(`%${query.q.trim()}%`);
  }

  const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);
  const orderBy = query.updated
    ? "json_extract(metadata_json, '$.previous.replacedAt') desc, id"
    : ORDER_BY[query.sort ?? "recent"] ?? ORDER_BY.recent;

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

  const typeRows = db
    .prepare(`
      select type, count(*) as c from memory_entries
      where status = 'available'
      group by type
    `)
    .all() as Array<{ type: string; c: number }>;

  const sourceRows = db
    .prepare(`
      select source, count(*) as c from memory_entries
      where status = 'available'
      group by source
    `)
    .all() as Array<{ source: string; c: number }>;

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

  const nameRows = db
    .prepare(`
      select distinct m.project_id as projectId, p.name as name
      from memory_entries m
      join projects p on p.id = m.project_id
      where m.status in ('available','archived')
    `)
    .all() as Array<{ projectId: string; name: string }>;

  return {
    totals: {
      available: totalsRow.available ?? 0,
      archived: totalsRow.archived ?? 0,
      total: totalsRow.total ?? 0
    },
    byScope: indexByKey(scopeRows, "scope", ["user", "project"]),
    byType: indexByKey(typeRows, "type", ["preference", "knowledge"]),
    bySource: indexByKey(sourceRows, "source", ["user", "agent", "extraction"]),
    byProject: projectRows,
    projectNames: Object.fromEntries(nameRows.map((row) => [row.projectId, row.name]))
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
    type: entry.type,
    source: entry.source,
    userQuote: entry.userQuote,
    status: entry.status,
    content: entry.content,
    sourceThreadId: entry.sourceThreadId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    metadata: entry.metadata
  };
}

/** Every brief, the user's first, each marked stale when its partition's
 *  entries are no longer the ones it was built from. */
export function listMemoryBriefs(db: Database): MemoryBriefsResponse {
  const names = new Map((db.prepare("select id, name from projects").all() as Array<{ id: string; name: string }>)
    .map((row) => [row.id, row.name]));
  const current = db.prepare(`
    select id, updated_at as updatedAt from memory_entries
    where status = 'available' and scope = ? and coalesce(project_id, '') = ?
  `);
  const briefs = listBriefs(db).map((brief) => ({
    scope: brief.scope,
    projectId: brief.projectId,
    projectName: brief.projectId ? names.get(brief.projectId) ?? null : null,
    content: brief.content,
    builtAt: brief.builtAt,
    stale: entriesDigest(current.all(brief.scope, brief.projectId ?? "") as Array<{ id: string; updatedAt: string }>) !== brief.inputDigest,
    tokens: estimateTextTokens(brief.content),
    tokenLimit: brief.scope === "user" ? BRIEF_TOKEN_LIMITS.user : BRIEF_TOKEN_LIMITS.project
  }));
  briefs.sort((a, b) => (a.scope === b.scope ? (a.projectName ?? "").localeCompare(b.projectName ?? "") : a.scope === "user" ? -1 : 1));
  return { briefs };
}

const EXTRACTED_WHEN: Record<string, string> = {
  compression: "Extracted when its conversation was compressed",
  worker_archive: "Extracted when the worker was archived",
  thread_archive: "Extracted when the thread was archived"
};

/** Where a memory came from and what happened to it since, newest first;
 *  null when there is no such memory. */
export function memoryEntryHistory(db: Database, id: string): MemoryEntryHistoryResponse | null {
  const row = db.prepare("select * from memory_entries where id = ?").get(id) as MemoryRow | undefined;
  if (!row) return null;
  const entry = rowToEntry(row);
  const meta = entry.metadata ?? {};
  const short = (other: string) => other.slice(0, 12);
  const names = new Map((db.prepare("select id, name from projects").all() as Array<{ id: string; name: string }>)
    .map((project) => [project.id, project.name]));
  const place = (value: Record<string, unknown> | null) =>
    value?.scope === "user" ? "your memories" : names.get(String(value?.projectId ?? "")) ?? "a project";

  const events: MemoryEntryHistoryEvent[] = [];
  // Told from what was recorded at the time: a memory restated in the
  // user's words later was not theirs when it was written. A statement dated
  // before the memory existed (the words it was extracted or split from) is
  // no restatement.
  const statedAt = typeof meta.statedAt === "string" && meta.statedAt > entry.createdAt ? meta.statedAt : null;
  const restated = statedAt !== null;
  const created = typeof meta.splitFrom === "string" ? `Split from ${short(meta.splitFrom)}`
    : typeof meta.extractionTrigger === "string" ? EXTRACTED_WHEN[meta.extractionTrigger] ?? "Extracted from a conversation"
      : restated ? "Remembered"
        : entry.source === "user" ? "Remembered from your words"
          : entry.source === "agent" ? "Remembered by an agent" : "Extracted from a conversation";
  events.push({ at: entry.createdAt, text: created });
  if (statedAt) events.push({ at: statedAt, text: "Restated in your words" });
  const last = memoryLastUpdate(entry);
  if (last?.byExtraction) {
    events.push({ at: last.at, text: "Updated from a conversation", ...(last.added ? { detail: `Added: ${last.added}` } : {}) });
  }
  const actions = db.prepare(`
    select action_type, memory_id, target_memory_id, reason, before_json, after_json, created_at
    from memory_dream_actions
    where status = 'applied' and (memory_id = ? or target_memory_id = ?)
  `).all(id, id) as Array<{ action_type: string; memory_id: string; target_memory_id: string | null; reason: string; before_json: string | null; after_json: string | null; created_at: string }>;
  for (const action of actions) {
    const before = parseJsonRecord(action.before_json);
    const after = parseJsonRecord(action.after_json);
    const text = action.memory_id !== id
      ? `The dream merged ${short(action.memory_id)} into this`
      : action.action_type === "merge" ? `The dream merged this into ${short(action.target_memory_id ?? "")}`
        : action.action_type === "update" ? "The dream updated this"
          : action.action_type === "archive" ? "The dream archived this"
            : action.action_type === "move" ? `The dream moved this from ${place(before)} to ${place(after)}`
              : action.action_type === "split" ? `The dream split this into ${splitCount(after)}`
                : `The dream: ${action.action_type}`;
    events.push({ at: action.created_at, text, ...(action.reason ? { detail: action.reason } : {}) });
  }
  if (entry.status === "archived" && typeof meta.forgottenReason === "string") {
    events.push({ at: entry.updatedAt, text: "Forgotten", detail: meta.forgottenReason });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  return { events, sourceThread: sourceThreadOf(db, entry.sourceThreadId) };
}

function splitCount(after: Record<string, unknown> | null): string {
  const parts = after?.metadata && typeof after.metadata === "object" ? (after.metadata as Record<string, unknown>).splitInto : null;
  return Array.isArray(parts) ? `${parts.length}` : "parts";
}

function sourceThreadOf(db: Database, threadId: string | null): MemoryEntryHistoryResponse["sourceThread"] {
  if (!threadId) return null;
  const thread = db.prepare("select id, scope, scope_id, title, archived_at from agent_threads where id = ?")
    .get(threadId) as { id: string; scope: string; scope_id: string | null; title: string | null; archived_at: string | null } | undefined;
  if (!thread) return null;
  // A subagent's thread stands for the conversation it worked for.
  if (thread.scope === "subagent") {
    const task = db.prepare("select parent_thread_id from background_tasks where child_thread_id = ?")
      .get(thread.id) as { parent_thread_id: string } | undefined;
    return task ? sourceThreadOf(db, task.parent_thread_id) : null;
  }
  if (thread.scope !== "manager" && thread.scope !== "worker" && thread.scope !== "global") return null;
  const feature = thread.scope === "worker" && thread.scope_id
    ? db.prepare(`
        select f.name, f.tmux_window_name as featureSlug, p.tmux_session_name as projectSlug,
               f.archived_at is not null as archived
        from features f join projects p on p.id = f.project_id where f.id = ?
      `).get(thread.scope_id) as { name: string; featureSlug: string; projectSlug: string; archived: number } | undefined
    : undefined;
  return {
    id: thread.id,
    scope: thread.scope,
    title: thread.title,
    projectSlug: feature?.projectSlug ?? null,
    featureSlug: feature?.featureSlug ?? null,
    featureName: feature?.name ?? null,
    archived: thread.archived_at !== null || Boolean(feature?.archived)
  };
}
