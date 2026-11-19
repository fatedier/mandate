import { MandateStore } from "../../src/server/app/store.js";

/**
 * An invented fortnight of calls for the Breakdown's charts: ten made-up
 * models whose first tokens, speeds, failures and prices differ enough to
 * spread across the speed map, with a cluster of similar ones (their labels
 * compete), one model behind two providers (its name needs the provider),
 * two that fail a tenth or more (red), one that answers whole (no first
 * token: it is named under the map, not placed), and one used only in the
 * last days (its lines start late).
 */
export interface SeedModel {
  /** The provider's name in Settings: what a group's key is built from. */
  provider: string;
  model: string;
  /** Calls a day. */
  daily: number;
  /** The first token's usual wait, ms; null for a model that answers whole. */
  ttftMs: number | null;
  /** Output tokens a second once it writes. */
  writes: number;
  failShare: number;
  /** A call's usual price in dollars; null for one with no price. */
  perCall: number | null;
  /** Days back the model was first used; the window's start when absent. */
  since?: number;
}

export const SEED_DAYS = 14;

export const SEED_MODELS: SeedModel[] = [
  { provider: "primary", model: "bolt/flash-3", daily: 200, ttftMs: 2_100, writes: 140, failShare: 0.001, perCall: 0.003 },
  { provider: "primary", model: "judge/check-1", daily: 120, ttftMs: null, writes: 90, failShare: 0.001, perCall: null },
  { provider: "primary", model: "acme/swift-5", daily: 90, ttftMs: 4_900, writes: 70, failShare: 0.03, perCall: 0.045 },
  { provider: "primary", model: "acme/atlas-large", daily: 60, ttftMs: 6_800, writes: 60, failShare: 0.004, perCall: 0.17 },
  { provider: "primary", model: "bolt/flash-2", daily: 40, ttftMs: 2_400, writes: 125, failShare: 0.024, perCall: 0.016 },
  { provider: "primary", model: "acme/atlas-medium", daily: 35, ttftMs: 6_700, writes: 72, failShare: 0.004, perCall: 0.036 },
  { provider: "primary", model: "bolt/flash-3.1", daily: 30, ttftMs: 19_000, writes: 95, failShare: 0.001, perCall: 0.003 },
  { provider: "mirror", model: "acme/swift-5", daily: 18, ttftMs: 7_400, writes: 56, failShare: 0.2, perCall: 0.12 },
  { provider: "primary", model: "acme/atlas-large-preview", daily: 10, ttftMs: 26_000, writes: 36, failShare: 0.28, perCall: 0.55, since: 4 },
  { provider: "direct", model: "kite/mini-2", daily: 12, ttftMs: 1_500, writes: 80, failShare: 0, perCall: 0.002 }
];

/** The group key the server builds for a model: `provider name / model`. */
export const seedKey = (model: SeedModel) => `${model.provider} / ${model.model}`;

const DAY_MS = 86_400_000;

export function seedBreakdownCalls(dataDir: string): void {
  // A small seeded random, so every run sees the same fortnight.
  let state = 7;
  const rand = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  const store = new MandateStore(dataDir);
  try {
    const insert = store.db.prepare(`
      insert into llm_calls (
        id, purpose, scope_type, scope_id, provider, provider_name, model,
        request_hash, response_hash, metadata_json,
        input_tokens, output_tokens, total_tokens, cache_read_tokens,
        status, error_json, started_at, finished_at, latency_ms, ttft_ms,
        created_at, updated_at, cost_source, cost_micros
      ) values (?, 'agent_wake_step', 'agent_thread', 'thread-e2e', 'openai-compatible', ?, ?,
                'req', 'res', ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    let n = 0;
    store.db.transaction(() => {
      for (const model of SEED_MODELS) {
        for (let back = Math.min(model.since ?? SEED_DAYS, SEED_DAYS) - 1; back >= 0; back -= 1) {
          const calls = Math.round(model.daily * (0.6 + rand() * 0.8));
          for (let i = 0; i < calls; i += 1) {
            n += 1;
            // Inside the day, never ahead of now: today's calls are in its past hours.
            const createdMs = now - back * DAY_MS - Math.floor(rand() * (back === 0 ? 0.25 : 0.9) * DAY_MS) - 60_000;
            const failed = rand() < model.failShare;
            const ttft = model.ttftMs === null ? null : Math.round(model.ttftMs * (0.7 + rand() * 0.6));
            const output = failed ? 0 : Math.round(300 + rand() * 1_500);
            const latency = (ttft ?? 400) + Math.round((output / model.writes) * 1000) + 120;
            const input = Math.round(20_000 + rand() * 80_000);
            const createdAt = new Date(createdMs).toISOString();
            const finishedAt = new Date(createdMs + latency).toISOString();
            const cost = model.perCall === null || failed ? null : Math.round(model.perCall * (0.6 + rand() * 0.8) * 1_000_000);
            insert.run(
              `llm_chart_${n}`, model.provider, model.model, JSON.stringify({ providerName: model.provider }),
              input, output, input + output, Math.round(input * 0.85),
              failed ? "failed" : "succeeded",
              failed ? JSON.stringify({ name: "AI_APICallError", message: "upstream overloaded, please retry" }) : null,
              createdAt, finishedAt, latency, ttft, createdAt, finishedAt,
              model.perCall === null ? "unpriced" : "list", cost
            );
          }
        }
      }
    })();
  } finally {
    store.db.close();
  }
}
