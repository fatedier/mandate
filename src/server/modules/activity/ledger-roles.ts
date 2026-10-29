/**
 * Who spent a call, and what woke the agent that made it: the names the
 * Activity ledger groups by. Keys, not labels — the client names them.
 */

const STEP = "agent_wake_step";

const SCOPE_ROLES: Record<string, string> = { global: "your_agent", manager: "managers", worker: "workers" };

const PURPOSE_ROLES: Record<string, string> = {
  page_subagent_step: "your_agents_page",
  subagent_step: "subagents",
  memory_dream: "dream",
  agent_compression: "compaction",
  agent_cache_seal: "cache_seal",
  memory_extraction: "memory_extraction",
  memory_repeat_check: "memory_repeat_check",
  manager_request_check: "manager_request_check",
  manager_stop_check: "manager_stop_check",
  web_search: "web_search"
};

const own = (table: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** The prefix of a role that is a bare purpose id: it can never be mistaken
 *  for a named role, whatever a purpose is called. */
export const PURPOSE_ROLE_PREFIX = "purpose:";

/**
 * A call's role. A step takes its thread's scope — the thread's row when it
 * still exists, else the scope the call recorded — and a step with neither
 * belongs to a thread deleted before calls recorded it. Anything unnamed is
 * `purpose:<id>`, so a new purpose shows up rather than vanishing.
 */
export function agentRoleOf(purpose: string, threadScope: string | null, threadKnown: boolean): string {
  if (purpose === STEP) {
    if (!threadScope) return threadKnown ? PURPOSE_ROLE_PREFIX + STEP : "deleted_thread";
    return own(SCOPE_ROLES, threadScope) ?? PURPOSE_ROLE_PREFIX + STEP;
  }
  return own(PURPOSE_ROLES, purpose) ?? PURPOSE_ROLE_PREFIX + purpose;
}

/** Guarded: json_extract raises on malformed text, and one bad row must not
 *  take the statement down (see ERROR_MESSAGE_SQL in activity-summary.ts). */
// Only a non-empty text counts as a recorded scope, as the ledger reads it.
const RECORDED_SCOPE_SQL = "(case when json_valid(llm_calls.metadata_json) and json_type(llm_calls.metadata_json, '$.threadScope') = 'text' and json_extract(llm_calls.metadata_json, '$.threadScope') <> '' then json_extract(llm_calls.metadata_json, '$.threadScope') end)";
const THREAD_ROW_SCOPE_SQL = "(select t.scope from agent_threads t where t.id = llm_calls.scope_id and llm_calls.scope_type = 'agent_thread')";

/** The thread's scope for a row of an unaliased `llm_calls`: its thread's
 *  row, else what the call recorded, else null. */
export const THREAD_SCOPE_SQL = `coalesce(${THREAD_ROW_SCOPE_SQL}, ${RECORDED_SCOPE_SQL})`;

const NOTHING = { sql: "(0)", params: [] as string[] };

/** The SQL condition selecting exactly the calls `agentRoleOf` gives `role`,
 *  for an unaliased `llm_calls`; a role no call can have selects nothing. */
export function agentRoleWhere(role: string): { sql: string; params: string[] } {
  const scope = Object.entries(SCOPE_ROLES).find(([, key]) => key === role)?.[0];
  if (scope) return { sql: `(purpose = '${STEP}' and ${THREAD_SCOPE_SQL} = ?)`, params: [scope] };
  if (role === "deleted_thread") return { sql: `(purpose = '${STEP}' and ${THREAD_SCOPE_SQL} is null)`, params: [] };
  const mapped = Object.entries(PURPOSE_ROLES).find(([, key]) => key === role)?.[0];
  if (mapped) return { sql: "(purpose = ?)", params: [mapped] };
  if (!role.startsWith(PURPOSE_ROLE_PREFIX)) return NOTHING;
  const purpose = role.slice(PURPOSE_ROLE_PREFIX.length);
  if (purpose === STEP) {
    return { sql: `(purpose = '${STEP}' and ${THREAD_SCOPE_SQL} is not null and ${THREAD_SCOPE_SQL} not in ('global', 'manager', 'worker'))`, params: [] };
  }
  return own(PURPOSE_ROLES, purpose) ? NOTHING : { sql: "(purpose = ?)", params: [purpose] };
}

export interface WakeGroup {
  key: string;
  /** Woken by a timer rather than by something arriving. */
  timer: boolean;
}

/** The wakes a timer starts. */
export const TIMER_WAKE_REASONS = ["alarm", "work-item-heartbeat"] as const;

const WAKE_KEYS: Record<string, string> = {
  user: "messages",
  "worker-report": "worker_reports",
  "thread-notice": "thread_notices",
  alarm: "alarms",
  "work-item-heartbeat": "check_ins",
  watch: "watches",
  monitor: "watches",
  "command-result": "command_results",
  "subagent-task": "subagent_tasks",
  "subagent-result": "subagent_tasks"
};

/** A wake reason's row in "What woke the agents"; an unknown reason is its own. */
export function wakeGroupOf(reason: string | null): WakeGroup {
  if (reason === null) return { key: "unknown", timer: false };
  return { key: own(WAKE_KEYS, reason) ?? reason, timer: (TIMER_WAKE_REASONS as readonly string[]).includes(reason) };
}
