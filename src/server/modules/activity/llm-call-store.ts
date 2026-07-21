import type { Database } from "bun:sqlite";
import { sha256 } from "../../platform/crypto/hash.js";
import { newId } from "../../platform/ids.js";
import { nowIso } from "../../platform/time/time.js";
import {
  buildLlmCallWhere,
  jsonOrNull,
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
  parentCallId?: string | null;
  provider?: string;
  model?: string;
  baseURL?: string;
  apiMode?: string;
  requestJson?: unknown;
  metadataJson?: unknown;
}

export interface FinishLlmCallInput {
  status?: string;
  responseJson?: unknown;
  outputJson?: unknown;
  usageJson?: unknown;
  metadataJson?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  reasoningTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  errorJson?: unknown;
  latencyMs?: unknown;
  ttftMs?: unknown;
}

export type { LlmCallFilters };

export class LlmCallStore {
  constructor(private readonly db: Database) {}

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
        latency_ms = coalesce(
          latency_ms,
          case
            when julianday(started_at) is null then null
            else max(0, cast((julianday(?) - julianday(started_at)) * 86400000 as integer))
          end
        ),
        updated_at = ?
      where status in ('running', 'pending')
    `
      )
      .run(errorJson, now, now, now);
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
        id, purpose, scope_type, scope_id, parent_call_id,
        provider, model, base_url, api_mode,
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
        input.parentCallId || null,
        normalizeShortText(input.provider),
        normalizeShortText(input.model),
        normalizeShortText(input.baseURL),
        normalizeShortText(input.apiMode),
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
    const errorJson = jsonOrNull(input.errorJson);
    this.db
      .prepare(
        `
      update llm_calls set
        response_hash = ?,
        response_json = ?,
        output_json = ?,
        usage_json = ?,
        metadata_json = coalesce(?, metadata_json),
        input_tokens = ?,
        output_tokens = ?,
        total_tokens = ?,
        reasoning_tokens = ?,
        cache_read_tokens = ?,
        cache_write_tokens = ?,
        status = ?,
        error_json = ?,
        finished_at = ?,
        latency_ms = ?,
        ttft_ms = ?,
        updated_at = ?
      where id = ?
    `
      )
      .run(
        responseJson ? sha256(responseJson) : "",
        responseJson,
        outputJson,
        usageJson,
        metadataJson,
        nullableInteger(input.inputTokens),
        nullableInteger(input.outputTokens),
        nullableInteger(input.totalTokens),
        nullableInteger(input.reasoningTokens),
        nullableInteger(input.cacheReadTokens),
        nullableInteger(input.cacheWriteTokens),
        normalizeStatus(input.status),
        errorJson,
        now,
        nullableInteger(input.latencyMs),
        nullableInteger(input.ttftMs),
        now,
        id
      );
  }

  listLlmCalls(limit = 50, options: LlmCallFilters = {}) {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
    const filter = buildLlmCallWhere(options);
    const rows = this.db
      .prepare(
        `
      select *
      from llm_calls
      ${filter.where}
      order by created_at desc, id desc
      limit ?
    `
      )
      .all(...filter.params, boundedLimit) as LlmCallRow[];

    return rows.map((row) => llmCallFromRow(row));
  }

  listLlmCallSummaries(limit = 20, options: LlmCallFilters = {}) {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
    const filter = buildLlmCallWhere(options);
    const rows = this.db
      .prepare(
        `
      select
        id, purpose, scope_type, scope_id, parent_call_id,
        provider, model, base_url, api_mode,
        request_hash, response_hash, metadata_json,
        input_tokens, output_tokens, total_tokens,
        reasoning_tokens, cache_read_tokens, cache_write_tokens,
        status, error_json, started_at, finished_at, latency_ms, ttft_ms,
        created_at, updated_at
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
