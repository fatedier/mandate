import { expect, test } from "bun:test";
import { listActivityFilterOptions } from "../src/server/modules/activity/filter-options.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

/** One call `minutesAgo` before now. */
function seed(
  db: import("bun:sqlite").Database,
  id: string,
  opts: { minutesAgo: number; purpose: string; provider: string; providerName: string; model: string }
) {
  const at = new Date(Date.now() - opts.minutesAgo * 60_000).toISOString();
  db.prepare(`
    insert into llm_calls (id, purpose, provider, provider_name, model, request_hash, response_hash, status, started_at, created_at, updated_at)
    values (?, ?, ?, ?, ?, 'rq', 'rs', 'succeeded', ?, ?, ?)
  `).run(id, opts.purpose, opts.provider, opts.providerName, opts.model, at, at, at);
}

test("every model and purpose with a call, the most recently used first, whatever their age", () => {
  const env = freshStoresEnv("md-activity-filter-options-");
  const db = env.store.db;
  // A year back: the log lists all history, so its filter does too.
  seed(db, "old", { minutesAgo: 525_600, purpose: "memory_dream", provider: "openai-compatible", providerName: "gateway", model: "acme/atlas-large" });
  seed(db, "mid", { minutesAgo: 60, purpose: "agent_wake_step", provider: "openai-compatible", providerName: "gateway", model: "bolt/flash-3" });
  // The same model behind another provider is its own entry.
  seed(db, "mirror", { minutesAgo: 30, purpose: "agent_wake_step", provider: "openai-compatible", providerName: "mirror", model: "bolt/flash-3" });
  seed(db, "codex", { minutesAgo: 20, purpose: "manager_stop_check", provider: "codex", providerName: "codex", model: "gpt-5.5" });
  // Used again: a model's place is its latest call, not its first.
  seed(db, "again", { minutesAgo: 5, purpose: "memory_dream", provider: "openai-compatible", providerName: "gateway", model: "acme/atlas-large" });
  // A call with no purpose names nothing to filter by.
  seed(db, "blank", { minutesAgo: 1, purpose: "", provider: "openai-compatible", providerName: "gateway", model: "bolt/flash-3" });

  expect(listActivityFilterOptions(db)).toEqual({
    models: [
      { provider: "gateway", model: "bolt/flash-3" },
      { provider: "gateway", model: "acme/atlas-large" },
      { provider: "codex", model: "gpt-5.5" },
      { provider: "mirror", model: "bolt/flash-3" }
    ],
    purposes: ["memory_dream", "manager_stop_check", "agent_wake_step"]
  });
});

test("an empty log has nothing to filter by", () => {
  const env = freshStoresEnv("md-activity-filter-options-empty-");
  expect(listActivityFilterOptions(env.store.db)).toEqual({ models: [], purposes: [] });
});
