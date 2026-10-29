import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { applyModelsPatch } from "../src/server/modules/settings/config-section-patches.js";
import { buildSettingsConfigPayload } from "../src/server/modules/settings/settings-payload.js";
import { providerBilling } from "../src/shared/settings.js";
import { tempDir } from "./helpers/temp.js";

function load(config: unknown) {
  const dir = tempDir("mandate-pricing-config-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
  return loadConfig(dir);
}

const gateway = (extra: Record<string, unknown> = {}) => ({
  type: "openai-compatible",
  baseURL: "https://gw.example.test/v1",
  apiKey: "test-key",
  models: [
    { id: "openai/gpt-6.1-sol", input: ["text"], price: { as: "litellm:gpt-6.1-sol" } },
    { id: "local-model", input: ["text"], price: { input: 3, output: 15, cacheWrite1h: 6 } },
    { id: "plain", input: ["text"] }
  ],
  ...extra
});

test("a model's price survives save and load", () => {
  const root: Record<string, unknown> = {};
  applyModelsPatch(root, { providers: { gw: gateway() } });
  const saved = (root.models as { providers: Record<string, { models: Array<Record<string, unknown>> }> }).providers.gw!.models;
  expect(saved.map((m) => m.price ?? null)).toEqual([
    { as: "litellm:gpt-6.1-sol" },
    { input: 3, output: 15, cacheWrite1h: 6 },
    null
  ]);
  const config = load({ models: { providers: { gw: gateway() } } });
  expect(config.models.providers.gw!.models.map((m) => m.price ?? null) as unknown[]).toEqual(saved.map((m) => m.price ?? null));
});

test.each([
  [{ input: -1, output: 2 }],
  [{ input: 1 }],
  [{ input: 1, output: 2, cacheRead: "0.1" }],
  [{ as: "" }],
  [{ as: "openai/gpt-6.1-sol" }],
  [{ as: "litellm:gpt-test", input: 1, output: 1 }],
  [{ as: "litellm:" }],
  [{ as: "genai-prices:openai/gpt" }],
  [{ as: "models.dev:fill" }]
])("a bad price %p is refused on save", (price) => {
  const root: Record<string, unknown> = {};
  expect(() => applyModelsPatch(root, { providers: { gw: gateway({ models: [{ id: "m", input: ["text"], price }] }) } }))
    .toThrow(/models\[\]\.price/);
});

test("a bad price in the config file is dropped on load, the model kept", () => {
  const config = load({ models: { providers: { gw: gateway({ models: [{ id: "m", input: ["text"], price: { input: -1, output: 1 } }] }) } } });
  expect(config.models.providers.gw!.models).toEqual([{ id: "m", input: ["text"] }]);
});

test("billing survives save and load; absent means the type's default", () => {
  const root: Record<string, unknown> = {};
  applyModelsPatch(root, { providers: { gw: gateway({ billing: "free" }), codex: { type: "codex" }, claude: { type: "anthropic", apiKey: "k" } } });
  const providers = (root.models as { providers: Record<string, Record<string, unknown>> }).providers;
  expect(providers.gw!.billing).toBe("free");
  expect(providers.codex!.billing).toBeUndefined();
  expect(() => applyModelsPatch({}, { providers: { gw: gateway({ billing: "monthly" }) } })).toThrow(/billing/);

  const config = load({ models: { providers: { gw: gateway({ billing: "free" }), codex: { type: "codex" }, claude: { type: "anthropic" } } } });
  expect(providerBilling(config.models.providers.gw!)).toBe("free");
  expect(providerBilling(config.models.providers.codex!)).toBe("plan");
  expect(providerBilling(config.models.providers.claude!)).toBe("usage");
});

test("billing usage can be set on codex, and the settings payload shows each connection's billing", () => {
  const config = load({ models: { providers: { codex: { type: "codex", billing: "usage" }, gw: gateway() } } });
  expect(providerBilling(config.models.providers.codex!)).toBe("usage");
  const payload = buildSettingsConfigPayload(false, { config });
  expect(payload.models.providers.codex!.billing).toBe("usage");
  expect(payload.models.providers.gw!.billing).toBe("usage");
  expect(payload.models.providers.gw!.models.find((m) => m.id === "local-model")!.price).toEqual({ input: 3, output: 15, cacheWrite1h: 6 });
});

test("prices.autoUpdate defaults to true and saves false", () => {
  expect(load({}).models.prices.autoUpdate).toBe(true);
  const root: Record<string, unknown> = {};
  applyModelsPatch(root, { prices: { autoUpdate: false } });
  expect((root.models as { prices: unknown }).prices).toEqual({ autoUpdate: false });
  expect(load({ models: { prices: { autoUpdate: false } } }).models.prices.autoUpdate).toBe(false);
  expect(buildSettingsConfigPayload(false, { config: load({ models: { prices: { autoUpdate: false } } }) }).models.prices.autoUpdate).toBe(false);
  expect(() => applyModelsPatch({}, { prices: { autoUpdate: "no" } })).toThrow(/autoUpdate/);
});

test("a price set on a Codex built-in model is kept in the payload", () => {
  const config = load({ models: { providers: { codex: { type: "codex", models: [{ id: "gpt-5.5", input: ["text"], price: { as: "litellm:gpt-5.5" } }] } } } });
  const payload = buildSettingsConfigPayload(false, { config });
  expect(payload.models.providers.codex!.models.find((m) => m.id === "gpt-5.5")!.price).toEqual({ as: "litellm:gpt-5.5" });
});
