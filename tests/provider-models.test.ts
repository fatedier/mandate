import { expect, test } from "bun:test";
import { fetchProviderModels } from "../src/server/modules/settings/provider-models.js";
import type { HttpClient } from "../src/server/platform/http/http-client.js";

function jsonHttp(payload: unknown, opts: { status?: number; capture?: { url?: string; headers?: Record<string, string> } } = {}): HttpClient {
  return {
    async fetch(input, init) {
      if (opts.capture) {
        opts.capture.url = String(input);
        opts.capture.headers = Object.fromEntries(new Headers(init?.headers).entries());
      }
      return new Response(JSON.stringify(payload), {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" }
      });
    }
  };
}

const neverHttp: HttpClient = {
  async fetch() {
    throw new Error("fetch must not be called");
  }
};

test("anthropic providers list live models from the anthropic models API", async () => {
  const capture: { url?: string; headers?: Record<string, string> } = {};
  const result = await fetchProviderModels(
    {
      type: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-a",
      models: [{ id: "claude-old", input: ["text", "image"] }]
    },
    { httpClient: jsonHttp({ data: [{ id: "claude-opus-4-7" }, { id: "claude-sonnet-4-6" }] }, { capture }) }
  );
  expect(capture.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
  expect(capture.headers?.["x-api-key"]).toBe("sk-a");
  expect(capture.headers?.["anthropic-version"]).toBeTruthy();
  expect(result.source).toBe("live");
  const ids = result.models.map((m) => m.id);
  expect(ids).toContain("claude-opus-4-7");
  expect(ids).toContain("claude-sonnet-4-6");
  // Configured models stay in the catalog even when the API doesn't list them.
  expect(ids).toContain("claude-old");
});

test("openai-compatible providers list live models from {baseURL}/models with a bearer key", async () => {
  const capture: { url?: string; headers?: Record<string, string> } = {};
  const result = await fetchProviderModels(
    {
      type: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-o",
      models: []
    },
    { httpClient: jsonHttp({ data: [{ id: "gpt-5.5" }] }, { capture }) }
  );
  expect(capture.url).toBe("https://api.openai.com/v1/models");
  expect(capture.headers?.["authorization"]).toBe("Bearer sk-o");
  expect(result.source).toBe("live");
  expect(result.models.map((m) => m.id)).toContain("gpt-5.5");
});

test("an anthropic base already ending in /v1 is not doubled", async () => {
  const capture: { url?: string } = {};
  await fetchProviderModels(
    { type: "anthropic", baseURL: "https://gw.example/v1", apiKey: "k", models: [] },
    { httpClient: jsonHttp({ data: [] }, { capture }) }
  );
  expect(capture.url).toBe("https://gw.example/v1/models?limit=1000");
});

test("a failed models request falls back to the configured models", async () => {
  const result = await fetchProviderModels(
    { type: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-o", models: [{ id: "gpt-5.5", input: ["text"] }] },
    { httpClient: jsonHttp({ error: "nope" }, { status: 500 }) }
  );
  expect(result.source).toBe("configured");
  expect(result.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
});

test("a provider without an api key never fetches and reports configured models", async () => {
  const result = await fetchProviderModels(
    { type: "openai", baseURL: "https://api.openai.com/v1", apiKey: "", models: [{ id: "gpt-5.5", input: ["text"] }] },
    { httpClient: neverHttp }
  );
  expect(result.source).toBe("configured");
  expect(result.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
});

test("codex keeps the builtin catalog and never fetches", async () => {
  const result = await fetchProviderModels(
    { type: "codex", baseURL: "", apiKey: "", models: [] },
    { httpClient: neverHttp }
  );
  expect(result.source).toBe("builtin");
  expect(result.models.length).toBeGreaterThan(0);
});

test("a configured model's capabilities win over the live entry with the same id", async () => {
  const result = await fetchProviderModels(
    {
      type: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-o",
      models: [{ id: "gpt-5.5", input: ["text", "image"], supportsReasoning: true }]
    },
    { httpClient: jsonHttp({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.6-sol" }] }) }
  );
  expect(result.source).toBe("live");
  const configured = result.models.find((m) => m.id === "gpt-5.5");
  expect(configured?.input).toEqual(["text", "image"]);
  expect(configured?.supportsReasoning).toBe(true);
  expect(result.models.map((m) => m.id)).toContain("gpt-5.6-sol");
});

test("without an http client the behavior stays configured-only (test/back-compat path)", async () => {
  const result = await fetchProviderModels({
    type: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-o",
    models: [{ id: "gpt-5.5", input: ["text"] }]
  });
  expect(result.source).toBe("configured");
  expect(result.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
});
