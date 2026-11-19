import type { Database } from "bun:sqlite";
import { sha256 } from "../../platform/crypto/hash.js";
import { newId } from "../../platform/ids.js";
import { nowIso } from "../../platform/time/time.js";
import {
  buildLlmCallWhere,
  jsonOrNull,
  normalizeFilterValue,
  llmCallFromRow,
  llmCallSummaryFromRow,
  type LlmCallFilters,
  type LlmCallRow,
  normalizeShortText,
  normalizeStatus,
  nullableInteger
} from "./llm-call-rows.js";

export interface StartLlmCallInput {
  id?: string;
  purpose?: string;
  scopeType?: string;
  scopeId?: string;
  provider?: string;
  model?: string;
  baseURL?: string;
  apiMode?: string;
  /** The provider connection's name in Settings. */
  providerName?: string;
  requestJson?: unknown;
  metadataJson?: unknown;
}

export interface FinishLlmCallInput {
  status?: string;
  responseJson?: unknown;
  outputJson?: unknown;
  usageJson?: unknown;
  metadataJson?: unknown;
  /** Why the reply ended ("length": at the output token limit), set into
   *  the metadata beside what it holds. */
  finishReason?: string;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  errorJson?: unknown;
  latencyMs?: unknown;
  ttftMs?: unknown;
  /** What the response said about its own price (see pricing/call-facts.ts). */
  reportedCostMicros?: number | null;
  reportedCostField?: string | null;
  cacheWrite1hTokens?: number | null;
  cacheWrite5mTokens?: number | null;
  serviceTier?: string | null;
}

export type { LlmCallFilters };

/** Below this many calls a provider's are read through the provider index;
 *  at it, walking every call in time order fills a page sooner. */
export const PROVIDER_INDEX_MAX_CALLS = 5_000;

export class LlmCallStore {
  constructor(private readonly db: Database) {}

  /** The filter's SQL, its provider read the cheaper way for the provider:
   *  how many calls it has is counted on the provider index, up to
   *  PROVIDER_INDEX_MAX_CALLS (a fraction of a millisecond either way). */
  private where(options: LlmCallFilters) {
    const provider = normalizeFilterValue(options.provider);
    if (!provider) return buildLlmCallWhere(options);
    const { n } = this.db.prepare(`
      select count(*) as n from (
        select 1 from llm_calls where provider_name = ? limit ${PROVIDER_INDEX_MAX_CALLS}
      )
    `).get(provider) as { n: number };
    return buildLlmCallWhere(options, { providerIndexed: n < PROVIDER_INDEX_MAX_CALLS });
  }

  /** A call still running at startup was cut off with the process that ran
   *  it. Its latency stays unrecorded: when it really stopped is unknown, and
   *  start-to-restart counted the downtime too (a call cut off by a
   *  shutdown read as days long, and fed the latency percentiles). */
  markInterruptedLiveCallsFailed() {
    const now = nowIso();
    const errorJson = jsonOrNull({
      name: "InterruptedLlmCall",
      message: "LLM call was still running when Mandate started; marked failed."
    });
    this.db
      .prepare(
        `
      update llm_calls set
        status = 'failed',
        error_json = coalesce(error_json, ?),
        finished_at = coalesce(finished_at, ?),
        updated_at = ?
      where status = 'running'
    `
      )
      .run(errorJson, now, now);
  }

  startLlmCall(input: StartLlmCallInput) {
    const id = input.id || newId("llm");
    const now = nowIso();
    const requestJson = jsonOrNull(input.requestJson);
    const metadataJson = jsonOrNull(input.metadataJson);
    this.db
      .prepare(
        `
      insert into llm_calls (
        id, purpose, scope_type, scope_id,
        provider, model, base_url, api_mode, provider_name,
        request_hash, request_json, metadata_json,
        status, started_at, created_at, updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `
      )
      .run(
        id,
        normalizeShortText(input.purpose, "unknown"),
        normalizeShortText(input.scopeType),
        normalizeShortText(input.scopeId),
        normalizeShortText(input.provider),
        normalizeShortText(input.model),
        normalizeShortText(input.baseURL),
        normalizeShortText(input.apiMode),
        // The connection: its Settings name, else the provider it ran on.
        normalizeShortText(input.providerName) || normalizeShortText(input.provider),
        requestJson ? sha256(requestJson) : "",
        requestJson,
        metadataJson,
        now,
        now,
        now
      );
    return { id, startedAt: now };
  }

  finishLlmCall(id: string, input: FinishLlmCallInput) {
    const now = nowIso();
    const responseJson = jsonOrNull(input.responseJson);
    const outputJson = jsonOrNull(input.outputJson);
    const usageJson = jsonOrNull(input.usageJson);
    const metadataJson = jsonOrNull(input.metadataJson);
    const finishReason = input.finishReason || null;
    const errorJson = jsonOrNull(input.errorJson);
    this.db
      .prepare(
        `
      update llm_calls set
        response_hash = ?,
        response_json = ?,
        output_json = ?,
        usage_json = ?,
        metadata_json = iif(? is null, coalesce(?, metadata_json), json_set(coalesce(?, metadata_json, '{}'), '$.finishReason', ?)),
        input_tokens = ?,
        output_tokens = ?,
        reasoning_tokens = ?,
        cache_read_tokens = ?,
        cache_write_tokens = ?,
        status = ?,
        error_json = ?,
        finished_at = ?,
        latency_ms = ?,
        ttft_ms = ?,
        reported_cost_micros = ?,
        reported_cost_field = ?,
        cache_write_1h_tokens = ?,
        cache_write_5m_tokens = ?,
        service_tier = ?,
        updated_at = ?
      where id = ?
    `
      )
      .run(
        responseJson ? sha256(responseJson) : "",
        responseJson,
        outputJson,
        usageJson,
        finishReason, metadataJson, metadataJson, finishReason,
        nullableInteger(input.inputTokens),
        nullableInteger(input.outputTokens),
        nullableInteger(input.reasoningTokens),
        nullableInteger(input.cacheReadTokens),
        nullableInteger(input.cacheWriteTokens),
        normalizeStatus(input.status),
        errorJson,
        now,
        nullableInteger(input.latencyMs),
        // A call the provider never answered has no first token: null, not 0.
        nullableInteger(input.ttftMs ?? undefined),
        // `nullableInteger(null)` is 0: an unreported cost must stay null.
        nullableInteger(input.reportedCostMicros ?? undefined),
        input.reportedCostField || null,
        nullableInteger(input.cacheWrite1hTokens ?? undefined),
        nullableInteger(input.cacheWrite5mTokens ?? undefined),
        input.serviceTier || null,
        now,
        id
      );
  }

  /** Lays `patch` over a call's metadata once it has been written: a JSON
   *  merge patch (nested objects merge, a null removes a key). A call whose
   *  metadata is not a readable object is left as it is. */
  mergeLlmCallMetadata(id: string, patch: unknown) {
    const patchJson = jsonOrNull(patch);
    if (!patchJson) return;
    this.db
      .prepare(`
        update llm_calls set metadata_json = json_patch(metadata_json, ?), updated_at = ?
        where id = ? and json_type(case when json_valid(metadata_json) then metadata_json end) = 'object'
      `)
      .run(patchJson, nowIso(), id);
  }

  listLlmCallSummaries(limit = 20, options: LlmCallFilters = {}) {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
    const filter = this.where(options);
    const rows = this.db
      .prepare(
        `
      select
        id, purpose, scope_type, scope_id,
        provider, model, base_url, api_mode,
        request_hash, response_hash, metadata_json,
        input_tokens, output_tokens,
        reasoning_tokens, cache_read_tokens, cache_write_tokens,
        status, error_json, started_at, finished_at, latency_ms, ttft_ms,
        created_at, updated_at,
        provider_name, cost_micros, cost_source, cost_api_micros, cost_ref, cost_note
      from llm_calls
      ${filter.where}
      order by created_at desc, id desc
      limit ?
    `
      )
      .all(...filter.params, boundedLimit) as Array<Omit<
        LlmCallRow,
        "request_json" | "response_json" | "output_json" | "usage_json"
      >>;

    return rows.map((row) => llmCallSummaryFromRow(row));
  }

  /** Every call the filters select, cursor aside: a view's whole set. */
  matchingLlmCallIds(options: LlmCallFilters = {}): string[] {
    const filter = this.where({ ...options, before: null, beforeId: null });
    return (this.db.prepare(`select id from llm_calls ${filter.where}`).all(...filter.params) as Array<{ id: string }>).map((row) => row.id);
  }

  /** How many calls the filters select, cursor aside. */
  countLlmCalls(options: LlmCallFilters = {}): number {
    const filter = this.where({ ...options, before: null, beforeId: null });
    return (this.db.prepare(`select count(*) as n from llm_calls ${filter.where}`).get(...filter.params) as { n: number }).n;
  }

  getLlmCall(id: string) {
    const row = this.db
      .prepare(
        `
      select *
      from llm_calls
      where id = ?
      limit 1
    `
      )
      .get(id) as LlmCallRow | null;
    if (!row) return null;
    return llmCallFromRow(row);
  }
}
