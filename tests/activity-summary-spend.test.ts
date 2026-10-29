import { expect, test } from "bun:test";
import { buildActivitySummary } from "../src/server/modules/activity/activity-summary.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

function seed(db: import("bun:sqlite").Database, id: string, opts: { model: string; source: string | null; micros?: number | null; api?: number | null; status?: string; ref?: string | null; providerName?: string; note?: string | null }) {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare(`insert into llm_calls (id, purpose, provider, model, status, started_at, created_at, updated_at, input_tokens, output_tokens,
    provider_name, cost_source, cost_micros, cost_api_micros, cost_ref, cost_note)
    values (?, 'agent_wake_step', 'openai-compatible', ?, ?, ?, ?, ?, 1000, 10, ?, ?, ?, ?, ?, ?)`)
    .run(id, opts.model, opts.status ?? "succeeded", at, at, at, opts.providerName ?? "gw", opts.source, opts.micros ?? null, opts.api ?? null, opts.ref ?? null, opts.note ?? null);
}

test("spend sums stored amounts; included and unpriced apart; pending counted", () => {
  const env = freshStoresEnv();
  const db = env.store.db;
  seed(db, "a", { model: "m-reported", source: "reported", micros: 4_200 });
  seed(db, "b", { model: "m-list", source: "list", micros: 10_000 });
  seed(db, "c", { model: "m-list", source: "unpriced" });
  seed(db, "d", { model: "m-plan", source: "included", api: 2_000 });
  seed(db, "e", { model: "m-list", source: null });
  seed(db, "f", { model: "m-list", source: null, status: "running" });
  seed(db, "g", { model: "m-free", source: "free" });
  seed(db, "h", { model: "m-list", source: "none" });
  const summary = buildActivitySummary(db, 7, "model");
  expect(summary.spend).toEqual({ micros: 14_200, reportedMicros: 4_200, estimated: true, pricedCalls: 2, unpricedCalls: 1, includedCalls: 1, includedApiMicros: 2_000, pendingCalls: 1 });
  const byModel = Object.fromEntries(summary.groups.map((g) => [g.key.split(" / ").pop(), g]));
  expect(byModel["m-reported"]).toMatchObject({ spendMicros: 4_200, spendEstimated: false, unpricedCalls: 0 });
  expect(byModel["m-list"]).toMatchObject({ spendMicros: 10_000, spendEstimated: true, unpricedCalls: 1 });
  expect(byModel["m-plan"]).toMatchObject({ spendMicros: 0, spendEstimated: false });
});

test("a window of reported charges only is not an estimate", () => {
  const env = freshStoresEnv();
  seed(env.store.db, "a", { model: "m", source: "reported", micros: 1 });
  expect(buildActivitySummary(env.store.db, 7, "model").spend.estimated).toBe(false);
});

test("the call summary carries its cost", () => {
  const env = freshStoresEnv();
  const db = env.store.db;
  seed(db, "a", { model: "m", source: "list", micros: 10_000, note: "no_cache_price", ref: JSON.stringify({ origin: "litellm", providerId: "anthropic", providerName: "Anthropic", modelId: "claude-opus-5-5", dataDate: "2026-10-21" }) });
  seed(db, "b", { model: "m", source: "reported", micros: 4_200, providerName: "my-proxy" });
  seed(db, "c", { model: "m", source: null });
  seed(db, "d", { model: "m", source: "list", micros: 1, ref: "{not json" });
  const calls = Object.fromEntries(env.store.listLlmCallSummaries(10).map((c) => [c.id, c]));
  expect(calls.a!.cost).toEqual({ source: "list", micros: 10_000, apiMicros: null, priceProvider: "Anthropic", priceModel: "claude-opus-5-5", priceOrigin: "litellm", dataDate: "2026-10-21", reportedBy: null, note: "no_cache_price" });
  expect(calls.b!.cost).toMatchObject({ source: "reported", micros: 4_200, reportedBy: "my-proxy" });
  expect(calls.c!.cost).toBeNull();
  expect(calls.d!.cost).toMatchObject({ source: "list", priceProvider: null });
  expect(env.store.getLlmCall("a")!.cost).toMatchObject({ source: "list" });
});
