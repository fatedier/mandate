import type {
  LlmCallDetailDto,
  LlmCallSummaryDto
} from "../../../shared/api-contracts.js";
import type { SqlValue } from "../../platform/db/sql-value.js";

export type LlmCallRow = {
  id: string;
  purpose: string;
  scope_type: string;
  scope_id: string;
  parent_call_id: string | null;
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
};

export interface LlmCallFilters {
  before?: string | null;
  beforeId?: string | null;
  status?: string | null;
  purpose?: string | null;
  provider?: string | null;
  model?: string | null;
  scopeType?: string | null;
  /** A single UTC day, `YYYY-MM-DD`. */
  day?: string | null;
  /** "1" for the calls the runtime marked as a fallback attempt, "0" for the
   *  rest. Anything else is no filter at all. */
  fallback?: string | null;
  q?: string | null;
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
    id: row.id,
    purpose: row.purpose,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    parentCallId: row.parent_call_id,
    provider: row.provider,
    model: row.model,
    baseURL: row.base_url,
    apiMode: row.api_mode,
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    request: parseJsonOrNull(row.request_json),
    response: parseJsonOrNull(row.response_json),
    output: parseJsonOrNull(row.output_json),
    usage: parseJsonOrNull(row.usage_json),
    metadata: parseJsonOrNull(row.metadata_json),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    status: row.status,
    error: parseJsonOrNull(row.error_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    latencyMs: row.latency_ms,
    ttftMs: row.ttft_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
    parentCallId: row.parent_call_id,
    provider: row.provider,
    model: row.model,
    baseURL: row.base_url,
    apiMode: row.api_mode,
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    request: null,
    response: null,
    output: null,
    usage: null,
    metadata: parseJsonOrNull(row.metadata_json),
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
    updatedAt: row.updated_at
  };
}

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
    clauses.push("provider = ?");
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
  const day = normalizeFilterValue(options.day);
  if (day) {
    clauses.push("created_at >= ? and created_at <= ?");
    params.push(`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`);
  }

  // Truthiness, not presence, because that is what the summary groups on:
  // `agent-compression-controller.ts` writes `fallbackAttempt: candidateIndex >
  // 0`, so a retry of the first candidate records a literal `false` and is a
  // primary call. A row with no marker, no metadata, or metadata that will not
  // parse reads as primary too — coalesce, so the null the guard produces lands
  // on the "0" side rather than in neither answer.
  const fallback = normalizeFilterValue(options.fallback);
  if (fallback === "1") {
    clauses.push(`coalesce(${FALLBACK_ATTEMPT_SQL}, 0) <> 0`);
  } else if (fallback === "0") {
    clauses.push(`coalesce(${FALLBACK_ATTEMPT_SQL}, 0) = 0`);
  }

  const q = normalizeFilterValue(options.q);
  if (q) {
    const prefix = `${q}%`;
    clauses.push(
      "(id = ? or parent_call_id = ? or request_hash = ? or response_hash = ? or id like ? or request_hash like ? or response_hash like ?)"
    );
    params.push(q, q, q, q, prefix, prefix, prefix);
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

function parseJsonOrNull(value: string | null) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function errorSummary(value: string | null) {
  const parsed = parseJsonOrNull(value);
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
