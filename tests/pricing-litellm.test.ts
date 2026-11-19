import { expect, test } from "bun:test";
import { litellmEntry, litellmProviderName, litellmSuggestion, trimLitellm } from "../src/server/modules/pricing/litellm.js";

// LiteLLM's key shapes, with sample rates (per token, as LiteLLM writes them).
const TABLE = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: "one of https://docs.litellm.ai/docs/providers", mode: "one of: chat, embedding" },
  "claude-test-1": {
    litellm_provider: "anthropic", mode: "chat",
    input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6, cache_creation_input_token_cost_above_1hr: 6e-6,
    input_cost_per_token_above_200k_tokens: 6e-6, output_cost_per_token_above_200k_tokens: 2.25e-5,
    cache_creation_input_token_cost_above_200k_tokens: 7.5e-6, cache_creation_input_token_cost_above_1hr_above_200k_tokens: 1.2e-5,
    input_cost_per_token_batches: 1.5e-6, search_context_cost_per_query: { search_context_size_low: 0.01 }
  },
  "gpt-test-5": {
    litellm_provider: "openai", mode: "chat",
    input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7,
    input_cost_per_token_above_272k_tokens: 4e-6, output_cost_per_token_above_272k_tokens: 1.5e-5,
    input_cost_per_token_flex: 1e-6, output_cost_per_token_flex: 5e-6,
    input_cost_per_token_above_272k_tokens_flex: 2e-6,
    input_cost_per_token_priority: 4e-6, output_cost_per_token_priority: 2e-5,
    input_cost_per_token_ultrafast: 1.2e-5
  },
  "gpt-test-responses": { litellm_provider: "openai", mode: "responses", input_cost_per_token: 1e-6, output_cost_per_token: 4e-6 },
  "gemini/gemini-test-2": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
  "deepseek/deepseek-test": { litellm_provider: "deepseek", mode: "chat", input_cost_per_token: 2.8e-7, output_cost_per_token: 4.2e-7, cache_read_input_token_cost: 2.8e-8 },
  "us.anthropic.claude-test-1": { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 3.3e-6, output_cost_per_token: 1.65e-5 },
  "dall-e-test": { litellm_provider: "openai", mode: "image_generation", output_cost_per_image: 0.04 },
  "text-embedding-test": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 1e-8, output_cost_per_token: 0 },
  "no-output-test": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6 },
  "negative-test": { litellm_provider: "openai", mode: "chat", input_cost_per_token: -1, output_cost_per_token: 1e-6 },
  "fireworks-ai-default": { litellm_provider: "fireworks_ai", input_cost_per_token: 9e-7, output_cost_per_token: 9e-7 },
  // A gateway's own entry for a model another provider also lists bare.
  "acme/claude-test-1": { litellm_provider: "acme", mode: "chat", input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
  // A bare entry beside the vendor-prefixed one.
  "gemini-test-2": { litellm_provider: "vertex_ai-language-models", mode: "chat", input_cost_per_token: 1.5e-6, output_cost_per_token: 1.2e-5 }
};

const trimmed = trimLitellm(TABLE, "2026-10-22");

test("chat and responses models with an input and an output price are kept; the rest are not", () => {
  expect(trimmed.date).toBe("2026-10-22");
  expect(Object.keys(trimmed.entries).sort()).toEqual([
    "acme/claude-test-1", "claude-test-1", "deepseek/deepseek-test", "gemini-test-2", "gemini/gemini-test-2", "gpt-test-5", "gpt-test-responses", "us.anthropic.claude-test-1"
  ]);
  expect(trimLitellm("not a table", "2026-10-22").entries).toEqual({});
});

test("the core rates, per 1M tokens, with the 1-hour write and the long-context tier", () => {
  expect(trimmed.entries["claude-test-1"]).toEqual({
    provider: "anthropic",
    rates: {
      base: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      tiers: [{ above: 200_000, rates: { input: 6, output: 22.5, cacheWrite: 7.5, cacheWrite1h: 12 } }]
    }
  });
  expect(trimmed.entries["deepseek/deepseek-test"]!.rates).toEqual({ base: { input: 0.28, output: 0.42, cacheRead: 0.028 } });
});

test("flex and priority rates, each with its own long-context tier; batch, ultrafast and fees are left out", () => {
  expect(trimmed.entries["gpt-test-5"]).toEqual({
    provider: "openai",
    rates: {
      base: { input: 2, output: 10, cacheRead: 0.1 },
      tiers: [{ above: 272_000, rates: { input: 4, output: 15 } }],
      flex: { base: { input: 1, output: 5 }, tiers: [{ above: 272_000, rates: { input: 2 } }] },
      priority: { base: { input: 4, output: 20 } }
    }
  });
});

test("a model is found under its provider, bare or prefixed, and not under another", () => {
  expect(litellmEntry(trimmed, "openai", "gpt-test-5")?.key).toBe("gpt-test-5");
  expect(litellmEntry(trimmed, "gemini", "gemini-test-2")?.key).toBe("gemini/gemini-test-2");
  expect(litellmEntry(trimmed, "anthropic", "gpt-test-5")).toBeNull();
  expect(litellmEntry(trimmed, "openai", "nothing-like-it")).toBeNull();
  // An object's own keys only.
  expect(litellmEntry(trimmed, "openai", "__proto__")).toBeNull();
  expect(litellmEntry(trimmed, "openai", "constructor")).toBeNull();
});

test("a suggestion by name: the whole id, then the part after a vendor prefix, then that part under the vendor", () => {
  expect(litellmSuggestion(trimmed, "deepseek/deepseek-test")?.key).toBe("deepseek/deepseek-test");
  expect(litellmSuggestion(trimmed, "openai/gpt-test-5")?.key).toBe("gpt-test-5");
  expect(litellmSuggestion(trimmed, "gemini/gemini-test-2")?.key).toBe("gemini/gemini-test-2");
  // Gateways name Google's models `google/…`; LiteLLM's provider is `gemini`.
  expect(litellmSuggestion(trimLitellm({ "gemini/gemini-test-3": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 } }, "d"), "google/gemini-test-3")?.key).toBe("gemini/gemini-test-3");
  expect(litellmSuggestion(trimmed, "deepseek/deepseek-test-unknown")).toBeNull();
  expect(litellmSuggestion(trimmed, "claude-test-1")?.key).toBe("claude-test-1");
  expect(litellmSuggestion(trimmed, "acme/nothing")).toBeNull();
  for (const id of ["__proto__", "constructor", "acme/__proto__", "toString"]) expect(litellmSuggestion(trimmed, id)).toBeNull();
  // The whole id before the part after its prefix, and that before the vendor's own key.
  expect(litellmSuggestion(trimmed, "acme/claude-test-1")).toMatchObject({ key: "acme/claude-test-1", provider: "acme" });
  expect(litellmSuggestion(trimmed, "google/gemini-test-2")?.key).toBe("gemini-test-2");
});

test("OpenAI, Anthropic and Google are named; other providers show their id", () => {
  expect(["openai", "anthropic", "gemini", "deepseek"].map(litellmProviderName)).toEqual(["OpenAI", "Anthropic", "Google", "deepseek"]);
  // Most bare gemini-* keys are Vertex's entries: named for the reader, not by LiteLLM's id.
  expect(litellmProviderName("vertex_ai-language-models")).toBe("Google Vertex AI");
});

test("an entry named like an object's built-ins is kept as an entry and changes nothing else", () => {
  const raw = JSON.parse('{"__proto__": {"litellm_provider": "openai", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6}}');
  const t = trimLitellm(raw, "2026-10-22");
  expect(Object.keys(t.entries)).toEqual(["__proto__"]);
  expect(litellmEntry(t, "openai", "__proto__")?.rates.base).toEqual({ input: 1, output: 2 });
  expect(Object.getPrototypeOf(t.entries) === null || Object.getPrototypeOf(t.entries) === Object.prototype).toBe(true);
  expect(JSON.parse(JSON.stringify(t)).entries.__proto__.provider).toBe("openai");
});

test("an entry priced $0 in and $0 out is never offered as what an id looks like", () => {
  const t = trimLitellm({
    "google/gemma-test": { litellm_provider: "openrouter", mode: "chat", input_cost_per_token: 0, output_cost_per_token: 0 },
    "gemma-test": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 8e-8, output_cost_per_token: 3.5e-7 },
    "zero-only": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 0, output_cost_per_token: 0 }
  }, "2026-10-22");
  expect(litellmSuggestion(t, "google/gemma-test")?.key).toBe("gemma-test");
  expect(litellmSuggestion(t, "zero-only")).toBeNull();
  expect(litellmSuggestion(t, "acme/zero-only")).toBeNull();
  // Still a price where its own provider's API is called: a free model is free.
  expect(litellmEntry(t, "openai", "zero-only")?.rates.base).toEqual({ input: 0, output: 0 });
});
