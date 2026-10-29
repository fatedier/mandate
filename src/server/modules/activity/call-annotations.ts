import type { Database } from "bun:sqlite";
import type { CacheVerdictDto, LlmCallLedgerDto, LlmCallSummaryDto, TokenSplitDto } from "../../../shared/api/activity.js";
import { ratesForStoredCall, splitStoredAmount, type StoredCostRow } from "../pricing/call-rates.js";
import type { RateSet } from "../pricing/rates.js";
import { extraMicros, type CacheVerdict } from "./cache-verdicts.js";
import { agentRoleOf, wakeGroupOf } from "./ledger-roles.js";
import type { LedgerDeps } from "./ledger-summary.js";
import { verdictForStep } from "./window-verdicts.js";

/** What a call needs to be annotated: the fields every call DTO carries. */
type AnnotatableCall = Pick<LlmCallSummaryDto,
  "id" | "purpose" | "scopeType" | "scopeId" | "provider" | "model" | "baseURL" | "status" |
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "startedAt" | "finishedAt" | "createdAt" | "ledger">;

/** Sources whose amount is spend, as the summary counts it. */
const SPEND_SOURCES = new Set(["reported", "your_price", "price_as", "list", "catalog"]);

interface ExtraRow {
  id: string;
  provider_name: string | null;
  cache_write_1h_tokens: number | null;
  cache_write_5m_tokens: number | null;
  service_tier: string | null;
  cost_source: string | null;
  cost_micros: number | null;
  cost_ref: string | null;
  thread_id: string | null;
  thread_scope: string | null;
  thread_title: string | null;
  /** A worker thread's worker: its name and the manager thread it works for. */
  worker_id: string | null;
  worker_name: string | null;
  worker_owner: string | null;
  meta: string | null;
}

const META_SQL = "case when json_valid(l.metadata_json) then json_extract(l.metadata_json, '$.threadScope', '$.wakeId', '$.wakeReason') end";

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function readMeta(meta: string | null): { threadScope: string | null; wakeId: string | null; wakeReason: string | null } {
  let values: unknown = null;
  try {
    values = meta ? JSON.parse(meta) : null;
  } catch {
    values = null;
  }
  const [threadScope, wakeId, wakeReason] = Array.isArray(values) ? values : [];
  return { threadScope: text(threadScope), wakeId: text(wakeId), wakeReason: text(wakeReason) };
}

function storedCost(call: AnnotatableCall, extra: ExtraRow): StoredCostRow {
  return {
    providerName: extra.provider_name,
    provider: call.provider, baseURL: call.baseURL, model: call.model,
    costSource: extra.cost_source, costRef: extra.cost_ref, costMicros: extra.cost_micros,
    inputTokens: call.inputTokens, outputTokens: call.outputTokens, cacheReadTokens: call.cacheReadTokens,
    cacheWriteTokens: call.cacheWriteTokens, cacheWrite1hTokens: extra.cache_write_1h_tokens, serviceTier: extra.service_tier
  };
}

interface Annotated {
  ledger: LlmCallLedgerDto;
  stored: StoredCostRow;
  rates: RateSet | null;
}

function annotate(db: Database, calls: AnnotatableCall[], deps: LedgerDeps): Map<string, Annotated> {
  const out = new Map<string, Annotated>();
  if (!calls.length) return out;
  const extras = db.prepare(`
    select l.id, l.provider_name, l.cache_write_1h_tokens, l.cache_write_5m_tokens, l.service_tier, l.cost_source, l.cost_micros, l.cost_ref,
           t.id thread_id, t.scope thread_scope, t.title thread_title,
           f.id worker_id, f.name worker_name, f.owner_thread_id worker_owner, ${META_SQL} meta
    from llm_calls l
    left join agent_threads t on t.id = l.scope_id and l.scope_type = 'agent_thread'
    left join features f on t.scope = 'worker' and f.id = t.scope_id
    where l.id in (select value from json_each(?))
  `).all(JSON.stringify(calls.map((c) => c.id))) as ExtraRow[];
  const byId = new Map(extras.map((row) => [row.id, row]));
  const metas = new Map(extras.map((row) => [row.id, readMeta(row.meta)]));

  const wakeIds = [...new Set([...metas.values()].map((m) => m.wakeId).filter((id): id is string => id !== null))];
  const reasons = new Map<string, string>();
  if (wakeIds.length) {
    for (const w of db.prepare("select id, reason from agent_wakes where id in (select value from json_each(?))").all(JSON.stringify(wakeIds)) as Array<{ id: string; reason: string }>) {
      reasons.set(w.id, w.reason);
    }
  }

  for (const call of calls) {
    const extra = byId.get(call.id);
    if (!extra) continue;
    const meta = metas.get(call.id)!;
    const stored = storedCost(call, extra);
    const isSpend = extra.cost_source !== null && SPEND_SOURCES.has(extra.cost_source);
    const rates = isSpend && extra.cost_source !== "reported" ? ratesForStoredCall(stored, deps.catalog, deps.providers) : null;

    let verdict: CacheVerdictDto | null = null;
    if (call.scopeType === "agent_thread" && call.scopeId) {
      const judged = verdictForStep(db, {
        id: call.id, purpose: call.purpose, scopeId: call.scopeId, model: call.model, apiType: call.provider,
        connection: extra.provider_name ?? call.provider, status: call.status,
        inputTokens: call.inputTokens, cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: call.cacheWriteTokens,
        cacheWrite1hTokens: extra.cache_write_1h_tokens, cacheWrite5mTokens: extra.cache_write_5m_tokens,
        startedAt: call.startedAt, finishedAt: call.finishedAt, createdAt: call.createdAt
      });
      if (judged) {
        verdict = {
          kind: judged.kind,
          idleMs: judged.idleMs,
          sinceStartMs: judged.sinceStartMs,
          rewrittenTokens: judged.shortfallTokens,
          extraMicros: rates ? extraMicros(judged, rates) : null,
          lifetimeMs: judged.lifetimeMs,
          requestedLifetimeMs: judged.requestedLifetimeMs,
          writtenLifetimeMs: judged.writtenLifetimeMs,
          rebuildCause: judged.rebuildCause,
          previousModel: judged.previousModel
        };
      }
    }

    const threadKnown = extra.thread_id !== null;
    const reason = meta.wakeId ? reasons.get(meta.wakeId) ?? meta.wakeReason : null;
    const role = agentRoleOf(call.purpose, extra.thread_scope ?? meta.threadScope, threadKnown);
    out.set(call.id, {
      ledger: {
        role,
        // A worker is known by its name (its thread keeps no title of its own).
        threadTitle: (extra.thread_scope === "worker" ? extra.worker_name || extra.thread_title : extra.thread_title) || null,
        threadDeleted: call.scopeType === "agent_thread" && !threadKnown,
        inThread: call.scopeType === "agent_thread",
        wakeKey: meta.wakeId ? wakeGroupOf(reason).key : null,
        link: linkFor(extra),
        verdict
      },
      stored,
      rates
    });
  }
  return out;
}

/** Where a call's thread is shown, by the thread's own scope (a compaction
 *  runs in the thread it compacts): a manager's thread page, Your agent's
 *  page, or a worker's tab in the manager thread it works for; anything else
 *  (a subagent's or a page's own thread) is shown nowhere. */
function linkFor(extra: ExtraRow): LlmCallLedgerDto["link"] {
  if (!extra.thread_id) return null;
  if (extra.thread_scope === "manager") return { to: "thread", threadId: extra.thread_id };
  if (extra.thread_scope === "global") return { to: "agent" };
  if (extra.thread_scope === "worker" && extra.worker_owner && extra.worker_id) return { to: "worker", threadId: extra.worker_owner, workerId: extra.worker_id };
  return null;
}

/** The calls with their role, thread, wake and cache verdict, judged as the
 *  summary judges them (one query for the page, one lookup per step). */
export function annotateCalls<T extends AnnotatableCall>(db: Database, calls: T[], deps: LedgerDeps): T[] {
  const annotated = annotate(db, calls, deps);
  return calls.map((call) => {
    const found = annotated.get(call.id);
    return found ? { ...call, ledger: found.ledger } : call;
  });
}

/** One call annotated, with its amount split by kind of token. */
export function annotateCallDetail<T extends AnnotatableCall>(db: Database, call: T, deps: LedgerDeps): T & { tokenSplit: TokenSplitDto | null } {
  const found = annotate(db, [call], deps).get(call.id);
  if (!found) return { ...call, tokenSplit: null };
  const split = found.rates ? splitStoredAmount(found.stored, found.rates) : null;
  let tokenSplit: TokenSplitDto | null = null;
  if (split) {
    const input = Math.max(0, call.inputTokens ?? 0);
    const read = Math.min(Math.max(0, call.cacheReadTokens ?? 0), input);
    const write = Math.min(Math.max(0, call.cacheWriteTokens ?? 0), input - read);
    const rows: TokenSplitDto["rows"] = [
      { kind: "cache_write", tokens: write, micros: split.cacheWrite },
      { kind: "cache_read", tokens: read, micros: split.cacheRead },
      { kind: "output", tokens: Math.max(0, call.outputTokens ?? 0), micros: split.output },
      { kind: "uncached_input", tokens: input - read - write, micros: split.uncachedInput }
    ];
    tokenSplit = { rows: rows.filter((row) => row.tokens > 0 || row.micros > 0) };
  }
  return { ...call, ledger: found.ledger, tokenSplit };
}

/** What these calls paid on top of a cache read, by their verdicts, counted
 *  as the ledger counts it: on calls whose amount is spend and has rates. */
export function extraForCalls(db: Database, verdicts: Map<string, CacheVerdict>, ids: string[], deps: LedgerDeps): number | null {
  if (!ids.length) return 0;
  const rows = db.prepare(`
    select l.id, l.provider, l.provider_name, l.base_url, l.model, l.input_tokens, l.output_tokens, l.cache_read_tokens,
           l.cache_write_tokens, l.cache_write_1h_tokens, l.service_tier, l.cost_source, l.cost_micros, l.cost_ref
    from llm_calls l where l.id in (select value from json_each(?))
  `).all(JSON.stringify(ids)) as Array<{
    id: string; provider: string; provider_name: string | null; base_url: string | null; model: string | null;
    input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
    cache_write_1h_tokens: number | null; service_tier: string | null; cost_source: string | null; cost_micros: number | null;
    cost_ref: string | null;
  }>;
  let total = 0;
  let priced = 0;
  for (const r of rows) {
    const verdict = verdicts.get(r.id);
    if (!verdict || !r.cost_source || !SPEND_SOURCES.has(r.cost_source) || r.cost_source === "reported") continue;
    const rates = ratesForStoredCall({
      providerName: r.provider_name, provider: r.provider, baseURL: r.base_url, model: r.model,
      costSource: r.cost_source, costRef: r.cost_ref, costMicros: r.cost_micros, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, cacheWrite1hTokens: r.cache_write_1h_tokens, serviceTier: r.service_tier
    }, deps.catalog, deps.providers);
    if (rates) {
      total += extraMicros(verdict, rates);
      priced += 1;
    }
  }
  // None of them has rates: what they paid on top is unknown, not $0.
  return priced > 0 ? total : null;
}
