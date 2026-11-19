import type { Database } from "bun:sqlite";
import type { ProviderConfig } from "../../src/server/config/types.js";
import { createPriceCatalog } from "../../src/server/modules/pricing/catalog.js";
import { freshStoresEnv } from "./fixtures.js";

/** Sample rates, per 1M tokens. */
export const ledgerCatalog = createPriceCatalog({
  litellm: {
    date: "2026-01-02",
    entries: Object.assign(Object.create(null), {
      "claude-test": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } } },
      "gpt-test": { provider: "openai", rates: { base: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } } }
    })
  },
  modelsDev: null
});
export const ledgerProviders: Record<string, ProviderConfig> = {};
export const ledgerDeps = { catalog: ledgerCatalog, providers: ledgerProviders };

export const CLAUDE = "anthropic/claude-test";
export const GPT = "openai/gpt-test";
const ref = (modelId: string, providerId: string) => JSON.stringify({ origin: "litellm", providerId, providerName: providerId, modelId, dataDate: "2026-01-02" });
const REFS: Record<string, string> = { [CLAUDE]: ref("claude-test", "anthropic"), [GPT]: ref("gpt-test", "openai") };

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Two days ago, so every call sits inside a 7-day window. */
export const BASE = Date.now() - 2 * DAY;
export const at = (ms: number) => new Date(BASE + ms).toISOString();

export interface CallSeed {
  id: string;
  purpose?: string;
  scopeType?: string;
  scopeId?: string;
  model?: string;
  /** The connection's API type (llm_calls.provider). */
  apiType?: string;
  status?: string;
  /** Start, relative to BASE; the call takes no time unless `took` says. */
  t: number;
  took?: number;
  latencyMs?: number | null;
  input?: number;
  read?: number;
  write?: number;
  output?: number;
  source?: string | null;
  micros?: number | null;
  ref?: string | null;
  metadata?: unknown;
}

/** A step records its thread's scope, as the wake loop writes it: the scope
 *  of the seeded thread it is in, unless the seed names one (or none exists).
 *  A call that names a wake records the wake's reason as well, unless the
 *  seed says which (`wakeReason: null`: none recorded). */
function stepMetadata(db: Database, c: CallSeed): string | null {
  if (typeof c.metadata === "string") return c.metadata;
  const metadata: Record<string, unknown> = { ...(c.metadata ?? {}) };
  if (typeof metadata.wakeId === "string" && metadata.wakeId && metadata.wakeReason === undefined) {
    const wake = db.prepare("select reason from agent_wakes where id = ?").get(metadata.wakeId) as { reason: string } | null;
    if (wake) metadata.wakeReason = wake.reason;
  }
  if ((c.purpose ?? "agent_wake_step") === "agent_wake_step" && (c.scopeType ?? "agent_thread") === "agent_thread" && metadata.threadScope === undefined) {
    const thread = db.prepare("select scope from agent_threads where id = ?").get(c.scopeId ?? "t-manager") as { scope: string } | null;
    if (thread) metadata.threadScope = thread.scope;
  }
  return c.metadata === undefined && Object.keys(metadata).length === 0 ? null : JSON.stringify(metadata);
}

export function seedCall(db: Database, c: CallSeed) {
  const model = c.model ?? CLAUDE;
  const start = at(c.t);
  // Claude goes through the Anthropic protocol, where Mandate marks its cache.
  const apiType = c.apiType ?? (model.includes("claude") ? "anthropic" : "openai-compatible");
  db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, provider_name, model, base_url, status, started_at, finished_at, created_at, updated_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, metadata_json, cost_source, cost_micros, cost_ref, latency_ms)
    values (?, ?, ?, ?, ?, 'gw', ?, 'https://gw.example.test/v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(
    c.id, c.purpose ?? "agent_wake_step", c.scopeType ?? "agent_thread", c.scopeId ?? "t-manager", apiType, model, c.status ?? "succeeded",
    start, at(c.t + (c.took ?? 0)), start, start,
    c.input ?? 100_000, c.output ?? 1_000, c.read ?? 0, c.write ?? 0,
    stepMetadata(db, c),
    c.source === undefined ? "list" : c.source, c.micros === undefined ? 100_000 : c.micros,
    c.ref === undefined ? (c.source === undefined || c.source === "list" ? REFS[model] ?? null : null) : c.ref,
    c.latencyMs === undefined ? 1_000 : c.latencyMs
  );
}

export function seedThread(db: Database, id: string, scope: string, title = `Invented ${scope}`) {
  const now = at(0);
  db.prepare("insert into agent_threads (id, scope, title, created_at, updated_at) values (?, ?, ?, ?, ?)").run(id, scope, title, now, now);
}

export function seedWake(db: Database, id: string, threadId: string, reason: string) {
  db.prepare("insert into agent_wakes (id, thread_id, reason, status, started_at) values (?, ?, ?, 'finished', ?)").run(id, threadId, reason, at(0));
}

/** A store with a manager, a personal agent and a worker thread. */
export function freshLedgerDb() {
  const env = freshStoresEnv();
  const db = env.store.db;
  seedThread(db, "t-manager", "manager");
  seedThread(db, "t-global", "personal");
  seedThread(db, "t-worker", "worker");
  return { env, db };
}

export const dayOf = (ms: number) => at(ms).slice(0, 10);

/** Twenty-five ordinary calls of two threads over a day and a half, in one wake. */
export function seedSteady(db: Database): void {
  seedWake(db, "w-1", "t-manager", "user");
  for (let i = 0; i < 12; i++) {
    seedCall(db, { id: `m-${i}`, t: i * 10 * MIN, read: i ? 90_000 : 0, write: i ? 0 : 100_000, metadata: { wakeId: "w-1", wakeReason: "user", threadScope: "manager" } });
    seedCall(db, { id: `w-${i}`, t: i * 7 * MIN + HOUR, scopeId: "t-worker", model: GPT, read: 50_000 });
  }
  seedCall(db, { id: "late", t: 30 * HOUR, model: CLAUDE, write: 80_000 });
}

/** seedSteady, and calls of every kind the Overview's two halves tell apart:
 *  fallbacks, a retry of the same candidate, metadata that is no JSON, a
 *  prompt longer than what was billed, a five-minute cache, a failure, a
 *  running call, a reported amount, an unpriced one, purposes outside any
 *  wake, and first-token times. */
export function seedVaried(db: Database): void {
  seedSteady(db);
  seedWake(db, "w-2", "t-global", "alarm");
  seedCall(db, { id: "fallback", t: 3 * HOUR, model: GPT, metadata: { fallbackAttempt: true, candidateIndex: 1, wakeId: "w-2", threadScope: "personal" }, scopeId: "t-global" });
  seedCall(db, { id: "retry", t: 3 * HOUR + MIN, model: GPT, metadata: { fallbackAttempt: false, attempt: 2, wakeId: "w-2", wakeReason: "alarm", threadScope: "personal" }, scopeId: "t-global" });
  seedCall(db, { id: "no-json", t: 4 * HOUR, metadata: '{"wakeId": "w-1", "threadScope": "mana' });
  // Marked for five minutes though it wrote for an hour (its system
  // instruction): the step twenty minutes later found the cache expired.
  seedCall(db, { id: "context", t: 5 * HOUR, read: 0, write: 60_000, metadata: { contextInputTokens: 60_000, cacheTtl: "5m", wakeId: "w-1", threadScope: "manager" } });
  db.prepare("update llm_calls set cache_write_1h_tokens = 60000 where id = 'context'").run();
  seedCall(db, { id: "after-context", t: 5 * HOUR + 20 * MIN, read: 10_000, write: 50_000, metadata: { cacheTtl: "1h", wakeId: "w-1", threadScope: "manager" } });
  seedCall(db, { id: "failed", t: 6 * HOUR, status: "failed", source: null, micros: null, latencyMs: 300 });
  db.prepare("update llm_calls set error_json = ? where id = 'failed'").run(JSON.stringify({ message: "Service Unavailable" }));
  seedCall(db, { id: "running", t: 7 * HOUR, status: "running", source: null, micros: null, latencyMs: null });
  seedCall(db, { id: "reported", t: 8 * HOUR, model: GPT, source: "reported", micros: 420_000, read: 20_000 });
  seedCall(db, { id: "unpriced", t: 9 * HOUR, model: "elsewhere/unknown-test", source: "unpriced", micros: null });
  seedCall(db, { id: "dream", t: 10 * HOUR, purpose: "memory_dream", scopeType: "", scopeId: "" });
  seedCall(db, { id: "check", t: 11 * HOUR, purpose: "manager_request_check", scopeType: "", scopeId: "", model: GPT });
  seedCall(db, { id: "compaction", t: 12 * HOUR, purpose: "agent_compression", write: 30_000 });
  // Streamed calls record when their first token came.
  db.prepare("update llm_calls set ttft_ms = 150 + cast(substr(id, 3) as integer) * 40 where id like 'm-%'").run();
}
