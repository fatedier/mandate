/**
 * Who spent a call, and what woke the agent that made it: the names the
 * Activity ledger groups by. Keys, not labels — the client names them.
 */

const STEP = "agent_wake_step";

/** A side chat's steps are one role with its summaries' calls (PURPOSE_ROLES). */
const SCOPE_ROLES: Record<string, string> = { personal: "personal_agent", manager: "managers", worker: "workers", side_chat: "side_chat" };

const PURPOSE_ROLES: Record<string, string> = {
  page_subagent_step: "personal_agent_page",
  subagent_step: "subagents",
  memory_dream: "dream",
  skill_review: "skill_review",
  // The call after a finished piece of work that may ask for a review.
  skill_review_nudge: "skill_review",
  // The weekly tidy of all learned skills, on the Skill review route.
  skill_tidy: "skill_review",
  agent_compression: "compaction",
  agent_cache_seal: "cache_seal",
  memory_extraction: "memory_extraction",
  memory_repeat_check: "memory_repeat_check",
  manager_request_check: "manager_request_check",
  manager_stop_check: "manager_stop_check",
  web_search: "web_search",
  tool_review: "tool_review",
  side_chat: "side_chat"
};

const own = (table: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** The prefix of a role that is a bare purpose id: it can never be mistaken
 *  for a named role, whatever a purpose is called. */
export const PURPOSE_ROLE_PREFIX = "purpose:";

/**
 * A call's role. A step takes the thread scope its call recorded. Anything
 * unnamed is `purpose:<id>`, so a new purpose shows up rather than vanishing.
 */
export function agentRoleOf(purpose: string, threadScope: string | null): string {
  if (purpose === STEP) return (threadScope && own(SCOPE_ROLES, threadScope)) || PURPOSE_ROLE_PREFIX + STEP;
  return own(PURPOSE_ROLES, purpose) ?? PURPOSE_ROLE_PREFIX + purpose;
}

/** The thread's scope for a row of an unaliased `llm_calls`, as the call
 *  recorded it (every step does), else null: only a non-empty text counts.
 *  Guarded: json_extract raises on malformed text, and one bad row must not
 *  take the statement down (see ERROR_MESSAGE_SQL in activity-summary.ts). */
export const THREAD_SCOPE_SQL = "(case when json_valid(llm_calls.metadata_json) and json_type(llm_calls.metadata_json, '$.threadScope') = 'text' and json_extract(llm_calls.metadata_json, '$.threadScope') <> '' then json_extract(llm_calls.metadata_json, '$.threadScope') end)";

const NOTHING = { sql: "(0)", params: [] as string[] };

/** The SQL condition selecting exactly the calls `agentRoleOf` gives `role`,
 *  for an unaliased `llm_calls`; a role no call can have selects nothing. */
export function agentRoleWhere(role: string): { sql: string; params: string[] } {
  const scope = Object.entries(SCOPE_ROLES).find(([, key]) => key === role)?.[0];
  // Every purpose the role holds (Skill review: the reviews and the calls that may ask for one).
  const mapped = Object.entries(PURPOSE_ROLES).filter(([, key]) => key === role).map(([purpose]) => purpose);
  const parts = [
    ...(scope ? [{ sql: `(purpose = '${STEP}' and ${THREAD_SCOPE_SQL} = ?)`, params: [scope] }] : []),
    ...(mapped.length === 1 ? [{ sql: "(purpose = ?)", params: mapped }] : []),
    ...(mapped.length > 1 ? [{ sql: `(purpose in (${mapped.map(() => "?").join(", ")}))`, params: mapped }] : [])
  ];
  if (parts.length === 1) return parts[0]!;
  if (parts.length > 1) return { sql: `(${parts.map((p) => p.sql).join(" or ")})`, params: parts.flatMap((p) => p.params) };
  if (!role.startsWith(PURPOSE_ROLE_PREFIX)) return NOTHING;
  const purpose = role.slice(PURPOSE_ROLE_PREFIX.length);
  if (purpose === STEP) {
    const named = Object.keys(SCOPE_ROLES).map((s) => `'${s}'`).join(", ");
    return { sql: `(purpose = '${STEP}' and coalesce(${THREAD_SCOPE_SQL} not in (${named}), 1))`, params: [] };
  }
  return own(PURPOSE_ROLES, purpose) ? NOTHING : { sql: "(purpose = ?)", params: [purpose] };
}

export interface WakeGroup {
  key: string;
  /** Woken by a timer rather than by something arriving. */
  timer: boolean;
}

/** The wakes a timer starts. */
export const TIMER_WAKE_REASONS = ["alarm", "sweep", "schedule", "calendar"] as const;

const WAKE_KEYS: Record<string, string> = {
  user: "messages",
  "worker-report": "worker_reports",
  "thread-notice": "thread_notices",
  alarm: "alarms",
  sweep: "worker_checks",
  "pane-monitor": "monitors",
  "command-monitor": "monitors",
  "command-result": "command_results",
  "subagent-task": "subagent_tasks",
  "subagent-result": "subagent_tasks",
  schedule: "scheduled_checks",
  calendar: "calendar"
};

/** A wake reason's row in "What woke the agents"; an unknown reason is its own. */
export function wakeGroupOf(reason: string | null): WakeGroup {
  if (reason === null) return { key: "unknown", timer: false };
  return { key: own(WAKE_KEYS, reason) ?? reason, timer: (TIMER_WAKE_REASONS as readonly string[]).includes(reason) };
}
