import type { Database } from "bun:sqlite";

/**
 * One stored call of a window, with every column the Overview reads: its
 * figures and its ledger are worked out from the same calls, read once.
 * A window holds every call of a month, and each read of them costs as much
 * as all the working out after it.
 */
export interface WindowCall {
  id: string;
  purpose: string;
  scope_type: string;
  scope_id: string;
  /** The connection's API type. */
  provider: string;
  provider_name: string | null;
  base_url: string | null;
  model: string;
  /** `provider_name` and `provider` again, under the names a thread's step is read by. */
  connection: string | null;
  api_type: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  latency_ms: number | null;
  ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_1h_tokens: number | null;
  cache_write_5m_tokens: number | null;
  service_tier: string | null;
  cost_source: string | null;
  cost_micros: number | null;
  cost_ref: string | null;
  /** The metadata keys below, as one JSON array; null where the metadata is
   *  no JSON. */
  meta: string | null;
  /** `$.threadScope`, `$.wakeId` and `$.wakeReason`: a non-empty text, else null. */
  recorded_scope: string | null;
  wake_id: string | null;
  recorded_wake_reason: string | null;
  /** `$.contextInputTokens` when it is a number, `$.cacheTtl` when a text. */
  context_tokens: number | null;
  cache_ttl: string | null;
  /** `$.fallbackAttempt` as recorded: read for its truth. */
  fallback: unknown;
}

/** The columns of a call the window's read selects. Named here once: the
 *  triggers that tell a kept slice it is out of date (slice-schema.ts) watch
 *  these same columns, so the read and the watch cannot drift apart. */
export const WINDOW_CALL_COLUMNS = [
  "id", "purpose", "scope_type", "scope_id", "provider", "provider_name", "base_url", "model",
  "status", "started_at", "finished_at", "created_at", "latency_ms", "ttft_ms",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_1h_tokens", "cache_write_5m_tokens",
  "service_tier", "cost_source", "cost_micros", "cost_ref"
] as const;

/** The metadata keys the Overview reads. */
export const WINDOW_META_PATHS = ["$.threadScope", "$.wakeId", "$.wakeReason", "$.contextInputTokens", "$.cacheTtl", "$.fallbackAttempt"] as const;

/** Every column of a call the Overview's answer is worked out from, the
 *  metadata aside (of it only WINDOW_META_PATHS): the window's read, and the
 *  failures' reasons, which read `error_json` too. */
export const ANSWER_COLUMNS = [...WINDOW_CALL_COLUMNS, "error_json"] as const;

/** One guarded read of `<row>.metadata_json`: json_extract raises on malformed
 *  text (one bad row must not take the statement down), and with several
 *  paths answers a JSON array, so the column is parsed once for all six keys. */
export function metaSql(row: string): string {
  return `case when json_valid(${row}.metadata_json)
    then json_extract(${row}.metadata_json, ${WINDOW_META_PATHS.map((path) => `'${path}'`).join(", ")})
  end`;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function readMeta(call: WindowCall): void {
  let values: unknown = null;
  try {
    values = call.meta ? JSON.parse(call.meta) : null;
  } catch {
    values = null;
  }
  const [threadScope, wakeId, wakeReason, contextTokens, cacheTtl, fallback] = Array.isArray(values) ? values as unknown[] : [];
  call.recorded_scope = text(threadScope);
  call.wake_id = text(wakeId);
  call.recorded_wake_reason = text(wakeReason);
  call.context_tokens = typeof contextTokens === "number" ? contextTokens : null;
  call.cache_ttl = typeof cacheTtl === "string" ? cacheTtl : null;
  call.fallback = fallback ?? null;
}

/** Every call created after `since` and before `until`, oldest first: the
 *  order the index on (created_at, id) reads them in, said so that what
 *  depends on which call came first (a model's first rates) is the same
 *  however the window is cut into reads. */
export function readWindowCalls(db: Database, since: string, until: string): WindowCall[] {
  const calls = db.prepare(`
    select ${WINDOW_CALL_COLUMNS.map((column) => `l.${column}`).join(", ")},
           l.provider_name connection, l.provider api_type,
           ${metaSql("l")} meta
    from llm_calls l
    where l.created_at > ? and l.created_at < ?
    order by l.created_at, l.id
  `).all(since, until) as WindowCall[];
  for (const call of calls) readMeta(call);
  return calls;
}
