import { expect, test } from "bun:test";
import { OPENROUTER_MODELS_URL, trimOpenRouter } from "../src/server/modules/pricing/openrouter.js";

// OpenRouter's model list, every output type, trimmed to what the calculator
// prices with: each model by its id, its core rates per 1M tokens.

test("the list is asked for with every output type, not only text", () => {
  expect(new URL(OPENROUTER_MODELS_URL).searchParams.get("output_modalities")).toBe("all");
});

test("trims OpenRouter's list to per-1M core rates by id; variable and unreadable prices are left out, $0 ones kept", () => {
  const trimmed = trimOpenRouter({
    data: [
      { id: "vendor/judge-1.14", name: "Vendor: Judge 1.14", pricing: { prompt: "0.000000042", completion: "0" } },
      { id: "vendor/chat-1", name: "Vendor: Chat 1", pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002", input_cache_write: "0.0000025", web_search: "0.01" } },
      // A router: its price depends on the model it picks.
      { id: "vendor/judge-router", pricing: { prompt: "-1", completion: "-1" } },
      { id: "vendor/chat-1:free", pricing: { prompt: "0", completion: "0" } },
      { id: 42, pricing: { prompt: "0.000001", completion: "0.000001" } },
      { id: "vendor/no-pricing" },
      { id: "vendor/bad", pricing: { prompt: "abc", completion: "0.000001" } },
      { id: "vendor/no-output", pricing: { prompt: "0.000001" } }
    ]
  }, "2026-11-03");
  expect(trimmed.date).toBe("2026-11-03");
  expect(Object.keys(trimmed.entries)).toEqual(["vendor/judge-1.14", "vendor/chat-1", "vendor/chat-1:free"]);
  expect(trimmed.entries["vendor/judge-1.14"]).toEqual({ rates: { base: { input: 0.042, output: 0 } } });
  expect(trimmed.entries["vendor/chat-1"]).toEqual({ rates: { base: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } } });
  expect(trimmed.entries["vendor/chat-1:free"]).toEqual({ rates: { base: { input: 0, output: 0 } } });
});

test("anything but a model list trims to no models", () => {
  for (const json of [null, "x", { data: "x" }, { models: [] }]) expect(trimOpenRouter(json, "2026-11-03").entries).toEqual({});
});

test("a model id like an object property is a model like any other", () => {
  const trimmed = trimOpenRouter({ data: [{ id: "__proto__", pricing: { prompt: "0.000001", completion: "0.000002" } }] }, "2026-11-03");
  expect(Object.hasOwn(trimmed.entries, "__proto__")).toBe(true);
});
