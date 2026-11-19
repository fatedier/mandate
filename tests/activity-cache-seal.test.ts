import { expect, test } from "bun:test";
import type { ActivitySummaryResponse } from "../src/shared/api-contracts.js";
import type { AppDeps } from "../src/server/app/deps.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { buildActivityTestApp } from "./helpers/activity-app.js";

// Activity names the models whose cache seal is paused, and until when.

async function summaryWith(deps: Partial<AppDeps>) {
  const env = freshStoresEnv("md-activity-cache-seal-");
  const app = buildActivityTestApp({ store: env.store, ...deps });
  return await (await app.request("/api/activity/summary?days=7")).json() as ActivitySummaryResponse;
}

test("the summary lists paused models", async () => {
  const at = Date.parse("2026-01-01T15:30:00.000Z");
  const body = await summaryWith({
    cacheSealPauses: () => [
      { connection: "gw", model: "anthropic/claude-sonnet-x", failure: "short_write", nextTryAt: at },
      { connection: "gw", model: "anthropic/claude-opus-x", failure: "output", nextTryAt: at, outputTokens: 120 }
    ]
  });
  expect(body.cacheSeal?.paused).toEqual([
    { model: "anthropic/claude-sonnet-x", failure: "short_write", nextTryAt: "2026-01-01T15:30:00.000Z" },
    { model: "anthropic/claude-opus-x", failure: "output", nextTryAt: "2026-01-01T15:30:00.000Z", outputTokens: 120 }
  ]);
});

test("no sealer, or nothing paused: an empty list", async () => {
  expect((await summaryWith({})).cacheSeal?.paused).toEqual([]);
  expect((await summaryWith({ cacheSealPauses: () => [] })).cacheSeal?.paused).toEqual([]);
});
