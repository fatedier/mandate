import type { Database } from "bun:sqlite";
import { judgeSequence, judgeStep, type CacheVerdict, type StepCall } from "./cache-verdicts.js";

/**
 * The one place a step is paired with the call before it, for the summary
 * and for the Logs rows alike: a count on the Overview and the list it opens
 * must judge every call the same way.
 */

export interface ThreadStep extends StepCall {
  scopeId: string;
}

/** The columns a StepCall is read from, for an unaliased `llm_calls`. */
export const STEP_COLUMNS = `id, purpose, scope_id, model, provider api_type, coalesce(provider_name, provider) connection, status,
  input_tokens, (case when json_valid(metadata_json) then json_extract(metadata_json, '$.contextInputTokens') end) context_tokens,
  cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cache_write_5m_tokens, started_at, finished_at, created_at,
  (case when json_valid(metadata_json) then json_extract(metadata_json, '$.cacheTtl') end) cache_ttl`;

interface StepRowRaw {
  id: string;
  purpose: string;
  scope_id: string;
  model: string | null;
  api_type: string | null;
  connection: string | null;
  status: string;
  input_tokens: number | null;
  context_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_1h_tokens: number | null;
  cache_write_5m_tokens: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  cache_ttl: string | null;
}

export function threadStepFromRow(r: StepRowRaw): ThreadStep {
  return {
    id: r.id, purpose: r.purpose, scopeId: r.scope_id, model: r.model, apiType: r.api_type, connection: r.connection, status: r.status,
    inputTokens: r.input_tokens, contextTokens: typeof r.context_tokens === "number" ? r.context_tokens : null,
    cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens,
    cacheWrite1hTokens: r.cache_write_1h_tokens, cacheWrite5mTokens: r.cache_write_5m_tokens,
    startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at,
    requestedCacheTtl: r.cache_ttl === "5m" || r.cache_ttl === "1h" ? r.cache_ttl : null
  };
}

// `+status`: without statistics (Mandate runs no ANALYZE) SQLite would read
// these through the status index and walk every older succeeded call for a
// thread with none before the point; the unary plus leaves it the thread index.
const ANCHORS = "scope_type = 'agent_thread' and purpose in ('agent_wake_step', 'agent_compression', 'agent_cache_seal') and +status = 'succeeded'";

/** The last anchor at or before a window's start (scope id, instant). */
export const PREVIOUS_THROUGH_SQL = `select ${STEP_COLUMNS} from llm_calls where ${ANCHORS} and scope_id = ? and created_at <= ? order by created_at desc, id desc limit 1`;
/** The last anchor before a call (scope id, its created_at twice, its id). */
export const PREVIOUS_BEFORE_SQL = `select ${STEP_COLUMNS} from llm_calls where ${ANCHORS} and scope_id = ? and (created_at < ? or (created_at = ? and id < ?)) order by created_at desc, id desc limit 1`;

/**
 * The thread's last succeeded step or compaction before a point: before a
 * call (earlier, or as early with a smaller id — the order the sequences are
 * judged in), or at or before a window's start.
 */
export function previousStepBefore(db: Database, scopeId: string, point: { createdAt: string; id: string } | { through: string }): ThreadStep | null {
  const row = "through" in point
    ? db.prepare(PREVIOUS_THROUGH_SQL).get(scopeId, point.through)
    : db.prepare(PREVIOUS_BEFORE_SQL).get(scopeId, point.createdAt, point.createdAt, point.id);
  return row ? threadStepFromRow(row as StepRowRaw) : null;
}

/** Verdicts for a window's steps and compactions (every call of each thread
 *  created after `sinceIso`), each thread's first judged against the call
 *  before the window. */
export function verdictsForSteps(db: Database, steps: ThreadStep[], sinceIso: string): Map<string, CacheVerdict> {
  const byThread = new Map<string, ThreadStep[]>();
  for (const step of steps) {
    const list = byThread.get(step.scopeId);
    if (list) list.push(step);
    else byThread.set(step.scopeId, [step]);
  }
  const verdicts = new Map<string, CacheVerdict>();
  for (const [scopeId, calls] of byThread) {
    for (const [id, verdict] of judgeSequence(calls, previousStepBefore(db, scopeId, { through: sinceIso }))) verdicts.set(id, verdict);
  }
  return verdicts;
}

/** Every step's verdict in the window after `sinceIso`. */
export function loadWindowVerdicts(db: Database, sinceIso: string): Map<string, CacheVerdict> {
  const rows = db.prepare(`
    select ${STEP_COLUMNS} from llm_calls
    where scope_type = 'agent_thread' and purpose in ('agent_wake_step', 'agent_compression', 'agent_cache_seal') and created_at > ?
  `).all(sinceIso) as StepRowRaw[];
  return verdictsForSteps(db, rows.map(threadStepFromRow), sinceIso);
}

/** One step's verdict, against the call before it however old. */
export function verdictForStep(db: Database, step: ThreadStep): CacheVerdict | null {
  if (step.purpose !== "agent_wake_step" || step.status !== "succeeded") return null;
  return judgeStep(previousStepBefore(db, step.scopeId, { createdAt: step.createdAt, id: step.id }), step);
}
