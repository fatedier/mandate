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
    c.metadata === undefined ? null : typeof c.metadata === "string" ? c.metadata : JSON.stringify(c.metadata),
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

/** A store with a manager, a global and a worker thread. */
export function freshLedgerDb() {
  const env = freshStoresEnv();
  const db = env.store.db;
  seedThread(db, "t-manager", "manager");
  seedThread(db, "t-global", "global");
  seedThread(db, "t-worker", "worker");
  return { env, db };
}

export const dayOf = (ms: number) => at(ms).slice(0, 10);
