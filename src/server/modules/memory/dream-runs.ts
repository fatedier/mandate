import type { Database } from "bun:sqlite";
import type { MemoryDreamActionDto, MemoryDreamRunDto, MemoryDreamTriggerResult } from "../../../shared/api-contracts.js";
import { parseJson, parseJsonRecord } from "../../platform/json.js";

/** What the routes and the background job need from the dream. */
export interface MemoryDreamTicker {
  tick(trigger: string, options?: { force?: boolean }): Promise<MemoryDreamTriggerResult>;
}

interface MemoryDreamRunRow {
  id: string;
  trigger: string;
  status: string;
  provider: string;
  model: string;
  phase: string;
  project_id: string | null;
  project_name: string | null;
  candidate_count: number;
  applied_count: number;
  error_json: string | null;
  metadata_json: string | null;
  started_at: string;
  finished_at: string | null;
  available_count_before: number | null;
  available_count_after: number | null;
  update_count: number;
  merge_count: number;
  archive_count: number;
  move_count: number;
  split_count: number;
}

interface MemoryDreamActionRow {
  id: string;
  run_id: string;
  action_type: string;
  status: string;
  memory_id: string;
  target_memory_id: string | null;
  before_json: string | null;
  after_json: string | null;
  reason: string;
  source_json: string | null;
  error_json: string | null;
  created_at: string;
  applied_at: string | null;
}

export function listMemoryDreamRuns(db: Database, limit = 20): MemoryDreamRunDto[] {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const rows = db.prepare(`
    select r.*, p.name as project_name,
      sum(case when a.status = 'applied' and a.action_type = 'update' then 1 else 0 end) as update_count,
      sum(case when a.status = 'applied' and a.action_type = 'merge' then 1 else 0 end) as merge_count,
      sum(case when a.status = 'applied' and a.action_type = 'archive' then 1 else 0 end) as archive_count,
      sum(case when a.status = 'applied' and a.action_type = 'move' then 1 else 0 end) as move_count,
      sum(case when a.status = 'applied' and a.action_type = 'split' then 1 else 0 end) as split_count
    from memory_dream_runs r
    left join projects p on p.id = r.project_id
    left join memory_dream_actions a on a.run_id = r.id
    group by r.id
    order by coalesce(r.finished_at, r.started_at) desc, r.started_at desc
    limit ?
  `).all(boundedLimit) as MemoryDreamRunRow[];
  return rows.map(memoryDreamRunFromRow);
}

export function getMemoryDreamRun(
  db: Database,
  id: string
): { run: MemoryDreamRunDto; actions: MemoryDreamActionDto[]; brief: { content: string; previous: string | null } | null } | null {
  const run = db.prepare(`
    select r.*, p.name as project_name,
      sum(case when a.status = 'applied' and a.action_type = 'update' then 1 else 0 end) as update_count,
      sum(case when a.status = 'applied' and a.action_type = 'merge' then 1 else 0 end) as merge_count,
      sum(case when a.status = 'applied' and a.action_type = 'archive' then 1 else 0 end) as archive_count,
      sum(case when a.status = 'applied' and a.action_type = 'move' then 1 else 0 end) as move_count,
      sum(case when a.status = 'applied' and a.action_type = 'split' then 1 else 0 end) as split_count
    from memory_dream_runs r
    left join projects p on p.id = r.project_id
    left join memory_dream_actions a on a.run_id = r.id
    where r.id = ?
    group by r.id
    limit 1
  `).get(id) as MemoryDreamRunRow | undefined;
  if (!run) return null;
  const actions = db.prepare(`
    select *
    from memory_dream_actions
    where run_id = ?
    order by created_at asc
  `).all(id) as MemoryDreamActionRow[];
  return {
    run: memoryDreamRunFromRow(run),
    actions: actions.map(memoryDreamActionFromRow),
    brief: runBrief(db, run)
  };
}

function memoryDreamRunFromRow(row: MemoryDreamRunRow): MemoryDreamRunDto {
  // The brief's text is the detail's to show; the list only says one was
  // written. The run's step log stays in the database: nothing shows it.
  const { brief, ...rest } = parseJsonRecord(row.metadata_json) ?? {};
  delete rest.steps;
  const metadata = row.metadata_json ? rest : null;
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    provider: row.provider,
    model: row.model,
    phase: normalizeDreamPhase(row.phase),
    projectId: row.project_id,
    projectName: row.project_name,
    candidateCount: row.candidate_count,
    appliedCount: row.applied_count,
    actionCount: numberOrNull(metadata?.actionCount),
    actionCounts: {
      update: row.update_count,
      merge: row.merge_count,
      archive: row.archive_count,
      move: row.move_count,
      split: row.split_count
    },
    rejectedCount: numberOrNull(metadata?.rejectedCount),
    failedCount: numberOrNull(metadata?.failedCount),
    finishReason: typeof metadata?.finishReason === "string" ? metadata.finishReason : null,
    error: parseJson(row.error_json),
    metadata,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    availableCountBefore: row.available_count_before,
    availableCountAfter: row.available_count_after,
    ...(typeof brief === "string" ? { briefWritten: true } : {})
  };
}

function memoryDreamActionFromRow(row: MemoryDreamActionRow): MemoryDreamActionDto {
  return {
    id: row.id,
    runId: row.run_id,
    actionType: row.action_type,
    status: row.status,
    memoryId: row.memory_id,
    targetMemoryId: row.target_memory_id,
    reason: row.reason,
    source: parseJson(row.source_json),
    error: parseJson(row.error_json),
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    createdAt: row.created_at,
    appliedAt: row.applied_at
  };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDreamPhase(value: string): MemoryDreamRunDto["phase"] {
  return value === "project" ? "project" : "user";
}

/** The brief a run wrote, and the one its partition's previous run wrote. */
function runBrief(db: Database, run: MemoryDreamRunRow): { content: string; previous: string | null } | null {
  const content = parseJsonRecord(run.metadata_json)?.brief;
  if (typeof content !== "string") return null;
  const before = db.prepare(`
    select json_extract(metadata_json, '$.brief') as brief from memory_dream_runs
    where phase = ? and coalesce(project_id, '') = ? and started_at < ?
      and json_extract(metadata_json, '$.brief') is not null
    order by started_at desc limit 1
  `).get(run.phase, run.project_id ?? "", run.started_at) as { brief: string } | undefined;
  return { content, previous: before?.brief ?? null };
}
