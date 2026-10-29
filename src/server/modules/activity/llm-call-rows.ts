import type {
  LlmCallDetailDto,
  LlmCallSummaryDto
} from "../../../shared/api-contracts.js";
import type { CallCostDto, CostNote, CostSource } from "../../../shared/api/pricing.js";
import type { SqlValue } from "../../platform/db/sql-value.js";
import { parseJson, parseJsonRecord } from "../../platform/json.js";
import { agentRoleWhere, TIMER_WAKE_REASONS } from "./ledger-roles.js";
import { dayClock, isCalendarDate, nextDate } from "./local-days.js";

export type LlmCallRow = {
  id: string;
  purpose: string;
  scope_type: string;
  scope_id: string;
  provider: string;
  model: string;
  base_url: string;
  api_mode: string;
  request_hash: string;
  response_hash: string;
  request_json: string | null;
  response_json: string | null;
  output_json: string | null;
  usage_json: string | null;
  metadata_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  status: string;
  error_json: string | null;
  started_at: string;
  finished_at: string | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  created_at: string;
  updated_at: string;
  provider_name?: string | null;
  cost_micros?: number | null;
  cost_source?: string | null;
  cost_api_micros?: number | null;
  cost_ref?: string | null;
  cost_note?: string | null;
};

export interface LlmCallFilters {
  before?: string | null;
  beforeId?: string | null;
  status?: string | null;
  purpose?: string | null;
  provider?: string | null;
  model?: string | null;
  scopeType?: string | null;
  /** A single day, `YYYY-MM-DD`: in `zone` when it names one, else UTC. */
  day?: string | null;
  /** The reader's time zone, which their days are cut in. */
  zone?: string | null;
  /** "1" for the calls the runtime marked as a fallback attempt, "0" for the
   *  rest. Anything else is no filter at all. */
  fallback?: string | null;
  q?: string | null;
  /** A ledger role; see agentRoleWhere. */
  agent?: string | null;
  /** failed | slow | expired | timers. `expired` lists `ids`. */
  view?: string | null;
  /** Calls created after this instant (a period view's window). */
  since?: string | null;
  /** The ids the `expired` view lists, worked out by the caller. */
  ids?: string[] | null;
}

/**
 * Whether a call recorded the marker that says it was a fallback attempt.
 *
 * `json_valid()` has to guard the extract rather than the row: `json_extract()`
 * *raises* "malformed JSON text" instead of answering null, so a single
 * unparseable `metadata_json` would abort the statement and take the caller
 * down with a 500. CASE evaluates only the branch it selects, which is what
 * makes the guard hold — under a bare `coalesce()`, or behind an `and`, the
 * extract is still reached. And an unparseable value here is a shape the system
 * chooses to keep: `retention.ts` deliberately leaves such a row alone rather
 * than spend a pass reading it.
 *
 * Lives here, beside the row this reads a column of, so the summary that groups
 * on it and the filter that selects on it cannot drift apart — a breakdown row
 * whose count came from one definition would open a log built from the other.
 */
export const FALLBACK_ATTEMPT_SQL = `case
    when json_valid(metadata_json)
    then json_extract(metadata_json, '$.fallbackAttempt')
  end`;

export function llmCallFromRow(row: LlmCallRow): LlmCallDetailDto {
  return {
    ...llmCallSummaryFromRow(row),
    request: parseJson(row.request_json),
    response: parseJson(row.response_json),
    output: parseJson(row.output_json),
    usage: parseJson(row.usage_json),
    error: parseJson(row.error_json),
    // The route fills it, for an Unpriced call: it needs the price catalog.
    priceSuggestion: null
  };
}

/** A row's stored price as the reader sees it; null while not priced yet. */
function costFromRow(row: Pick<LlmCallRow, "provider_name" | "cost_micros" | "cost_source" | "cost_api_micros" | "cost_ref" | "cost_note">): CallCostDto | null {
  if (!row.cost_source) return null;
  const ref = parseJsonRecord(row.cost_ref ?? null);
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    source: row.cost_source as CostSource,
    micros: row.cost_micros ?? null,
    apiMicros: row.cost_api_micros ?? null,
    priceProvider: text(ref?.providerName),
    priceModel: text(ref?.modelId),
    priceOrigin: ref?.origin === "litellm" || ref?.origin === "models.dev" ? ref.origin : null,
    dataDate: text(ref?.dataDate),
    reportedBy: row.cost_source === "reported" ? row.provider_name ?? null : null,
    note: (row.cost_note as CostNote | null) ?? null
  };
}

export function llmCallSummaryFromRow(
  row: Omit<LlmCallRow, "request_json" | "response_json" | "output_json" | "usage_json">
): LlmCallSummaryDto {
  return {
    id: row.id,
    purpose: row.purpose,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    provider: row.provider,
    providerName: row.provider_name ?? null,
    model: row.model,
    baseURL: row.base_url,
    apiMode: row.api_mode,
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    request: null,
    response: null,
    output: null,
    usage: null,
    metadata: parseJsonRecord(row.metadata_json),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    status: row.status,
    error: errorSummary(row.error_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    latencyMs: row.latency_ms,
    ttftMs: row.ttft_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cost: costFromRow(row)
  };
}

/** The slowest latency bucket's floor: what the Slow view lists. */
const SLOW_MS = 60_000;

/** Calls of a wake a timer started (its row's reason, else the reason the
 *  call recorded), and the dream's calls. Guarded metadata reads. */
// Qualified: inside the subquery a bare `metadata_json` is agent_wakes' own column.
// A wake id is a non-empty text, as the ledger reads it: a reason recorded
// without one belongs to no wake.
const WAKE_ID_SQL = "(case when json_valid(llm_calls.metadata_json) and json_type(llm_calls.metadata_json, '$.wakeId') = 'text' and json_extract(llm_calls.metadata_json, '$.wakeId') <> '' then json_extract(llm_calls.metadata_json, '$.wakeId') end)";
const RECORDED_REASON_SQL = "(case when json_valid(llm_calls.metadata_json) then json_extract(llm_calls.metadata_json, '$.wakeReason') end)";
const TIMERS_SQL = `(purpose = 'memory_dream' or (${WAKE_ID_SQL} is not null and coalesce((select w.reason from agent_wakes w where w.id = ${WAKE_ID_SQL}), ${RECORDED_REASON_SQL}) in (${TIMER_WAKE_REASONS.map((r) => `'${r}'`).join(", ")})))`;

/** The provider a call is grouped and filtered by: its name from Settings
 *  (a gateway connection's name, kilo), or for a row that has none (older
 *  calls) the family it was recorded under. Activity's "Provider / model" and
 *  the log filter. */
export const PROVIDER_KEY_SQL = "coalesce(provider_name, provider)";

export function buildLlmCallWhere(options: LlmCallFilters) {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  // Keyset pagination over the same (created_at, id) order the queries sort by.
  // `created_at` is whole-millisecond, so a plain `created_at < ?` cursor skips
  // every remaining row of a group that shares the boundary millisecond —
  // silently, since a row that never arrives raises nothing. The id keeps the
  // order total; it is random rather than monotonic, which costs nothing here
  // because a tiebreaker only has to be unique and consistently compared.
  const before = normalizeFilterValue(options.before);
  const beforeId = normalizeFilterValue(options.beforeId);
  if (before && beforeId) {
    clauses.push("(created_at < ? or (created_at = ? and id < ?))");
    params.push(before, before, beforeId);
  } else if (before) {
    clauses.push("created_at < ?");
    params.push(before);
  }

  const status = normalizeFilterValue(options.status);
  if (status && status !== "all") {
    if (status === "failed") {
      clauses.push("status not in ('succeeded', 'running', 'pending')");
    } else if (status === "running") {
      clauses.push("status in ('running', 'pending')");
    } else {
      clauses.push("status = ?");
      params.push(status);
    }
  }

  const purpose = normalizeFilterValue(options.purpose);
  if (purpose) {
    clauses.push("purpose = ?");
    params.push(purpose);
  }

  const provider = normalizeFilterValue(options.provider);
  if (provider) {
    clauses.push(`${PROVIDER_KEY_SQL} = ?`);
    params.push(provider);
  }

  const model = normalizeFilterValue(options.model);
  if (model) {
    clauses.push("model = ?");
    params.push(model);
  }

  const scopeType = normalizeFilterValue(options.scopeType);
  if (scopeType) {
    clauses.push("scope_type = ?");
    params.push(scopeType);
  }

  // A closed range on the ISO string rather than `like 'YYYY-MM-DD%'`. The day
  // comes off a url, and under `like` a `%` or `_` in it stops being a date and
  // becomes a pattern — `2026-08-0_` would answer with nine days. The range also
  // keeps the (scope_type, scope_id, created_at) index usable, which a leading
  // wildcard-capable match does not.
  //
  // Both bounds are inclusive because `created_at` is whole-millisecond (the
  // cursor above depends on the same fact), so `23:59:59.999Z` is the last
  // instant of the day rather than a value nothing can hold. Building the
  // exclusive next-day bound instead would mean date arithmetic on unvalidated
  // input, which is how `new Date(NaN).toISOString()` throws.
  //
  // In the reader's zone the day runs from their midnight to the next, which
  // takes date arithmetic: only a date that exists gets it, and any other
  // value matches nothing, as it does in UTC.
  const day = normalizeFilterValue(options.day);
  const zone = normalizeFilterValue(options.zone);
  if (day && zone) {
    if (isCalendarDate(day)) {
      const clock = dayClock(zone);
      const start = new Date(clock.startOf(day)).toISOString();
      const end = new Date(clock.startOf(nextDate(day))).toISOString();
      // Past year 9999 an ISO string gains a sign and no longer sorts as
      // text; nothing stored is that late, so the last day needs no end.
      if (end.startsWith("+")) {
        clauses.push("created_at >= ?");
        params.push(start);
      } else {
        clauses.push("created_at >= ? and created_at < ?");
        params.push(start, end);
      }
    } else {
      clauses.push("0");
    }
  } else if (day) {
    clauses.push("created_at >= ? and created_at <= ?");
    params.push(`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`);
  }

  // Truthiness, not presence, because that is what the summary groups on:
  // `llmAttemptMetadata` writes `fallbackAttempt: candidateIndex > 0`, so a
  // retry of the first candidate records a literal `false` and is a primary
  // call. (Rows written before 2026-09-19 by the wake and dream loops carry
  // `true` on such a retry; those only happened with no fallback configured.)
  // A row with no marker, no metadata, or metadata that will not
  // parse reads as primary too — coalesce, so the null the guard produces lands
  // on the "0" side rather than in neither answer.
  const fallback = normalizeFilterValue(options.fallback);
  if (fallback === "1") {
    clauses.push(`coalesce(${FALLBACK_ATTEMPT_SQL}, 0) <> 0`);
  } else if (fallback === "0") {
    clauses.push(`coalesce(${FALLBACK_ATTEMPT_SQL}, 0) = 0`);
  }

  const since = normalizeFilterValue(options.since);
  if (since) {
    clauses.push("created_at > ?");
    params.push(since);
  }

  const agent = normalizeFilterValue(options.agent);
  if (agent) {
    const role = agentRoleWhere(agent);
    clauses.push(role.sql);
    params.push(...role.params);
  }

  switch (normalizeFilterValue(options.view)) {
    case "failed":
      clauses.push("status not in ('succeeded', 'running', 'pending')");
      break;
    case "slow":
      clauses.push(`latency_ms >= ${SLOW_MS}`);
      break;
    case "timers":
      clauses.push(TIMERS_SQL);
      break;
    case "expired":
      clauses.push("id in (select value from json_each(?))");
      params.push(JSON.stringify(options.ids ?? []));
      break;
  }

  const q = normalizeFilterValue(options.q);
  if (q) {
    const prefix = `${q}%`;
    clauses.push(
      "(id = ? or request_hash = ? or response_hash = ? or id like ? or request_hash like ? or response_hash like ?)"
    );
    params.push(q, q, q, prefix, prefix, prefix);
  }

  return {
    where: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "",
    params
  };
}

export function normalizeShortText(value: unknown, fallback = "") {
  return String(value ?? fallback)
    .trim()
    .slice(0, 240);
}

export function normalizeStatus(value: unknown) {
  const status = normalizeShortText(value, "unknown");
  return status || "unknown";
}

export function jsonOrNull(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

export function nullableInteger(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.max(0, Math.floor(number));
}

function normalizeFilterValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 240) : null;
}

function errorSummary(value: string | null) {
  const parsed = parseJson(value);
  if (!parsed) return null;
  if (typeof parsed === "string") return { message: parsed };
  if (typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    return {
      name: typeof obj.name === "string" ? obj.name : undefined,
      message: typeof obj.message === "string" ? obj.message : JSON.stringify(parsed)
    };
  }
  return { message: String(parsed) };
}
