import { expect, test } from "bun:test";
import { fetchProviderModels, type ProviderModelsResult } from "../src/server/modules/settings/provider-models.js";
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

const OPENROUTER_SHAPED = {
  data: [
    { id: "deepseek/deepseek-v4-pro", architecture: { input_modalities: ["text"] }, supported_parameters: ["reasoning", "tools"], context_length: 1048576 },
    { id: "tencent/hy-mt2-7b", architecture: { input_modalities: ["text"] }, supported_parameters: ["temperature"] },
    { id: "openai/gpt-6.1-sol", architecture: { input_modalities: ["text", "image", "file"] }, supported_parameters: ["include_reasoning", "tools"] }
  ]
};

test("a listing that declares capabilities: text-only and no-reasoning models start off and say the list declared it", async () => {
  const result = await fetchProviderModels(
    { type: "kilo", baseURL: "https://api.kilo.ai/api/gateway", apiKey: "k", models: [] },
    { httpClient: jsonHttp(OPENROUTER_SHAPED) }
  );
  const byId = new Map(result.models.map((m) => [m.id, m]));
  expect(byId.get("deepseek/deepseek-v4-pro")).toMatchObject({ input: ["text"], declared: { image: false, reasoning: true }, contextLength: 1048576 });
  expect(byId.get("deepseek/deepseek-v4-pro")?.supportsReasoning).toBeUndefined();
  expect(byId.get("tencent/hy-mt2-7b")).toMatchObject({ input: ["text"], supportsReasoning: false, declared: { image: false, reasoning: false } });
  expect(byId.get("openai/gpt-6.1-sol")).toMatchObject({ input: ["text", "image"], declared: { image: true, reasoning: true } });
});

test("a listing that declares nothing (LiteLLM-shaped) leaves both on and declares nothing", async () => {
  const result = await fetchProviderModels(
    { type: "openai-compatible", baseURL: "https://team-proxy.example/v1", apiKey: "k", models: [] },
    { httpClient: jsonHttp({ data: [{ id: "openai/gpt-6-luna", object: "model", owned_by: "openai" }] }) }
  );
  const luna = result.models.find((m) => m.id === "openai/gpt-6-luna")!;
  expect([luna.input, luna.supportsReasoning, luna.declared]).toEqual([["text", "image"], undefined, undefined]);
});

test("malformed capability fields read as undeclared", async () => {
  const result = await fetchProviderModels(
    { type: "openai-compatible", baseURL: "https://gw.example/v1", apiKey: "k", models: [] },
    { httpClient: jsonHttp({ data: [{ id: "odd", architecture: null, supported_parameters: "reasoning" }, { id: "odd2", architecture: { input_modalities: "text" } }] }) }
  );
  for (const id of ["odd", "odd2"]) {
    const m = result.models.find((x) => x.id === id)!;
    expect([id, m.input, m.supportsReasoning, m.declared]).toEqual([id, ["text", "image"], undefined, undefined]);
  }
});

test("a configured model keeps its stored values but carries the listing's declaration", async () => {
  const result = await fetchProviderModels(
    {
      type: "kilo",
      baseURL: "https://api.kilo.ai/api/gateway",
      apiKey: "k",
      models: [
        { id: "deepseek/deepseek-v4-pro", input: ["text", "image"], supportsReasoning: true },
        { id: "only-configured", input: ["text"] }
      ]
    },
    { httpClient: jsonHttp(OPENROUTER_SHAPED) }
  );
  const configured = result.models.find((m) => m.id === "deepseek/deepseek-v4-pro")!;
  expect([configured.input, configured.supportsReasoning, configured.declared]).toEqual([["text", "image"], true, { image: false, reasoning: true }]);
  expect(result.models.find((m) => m.id === "only-configured")?.declared).toBeUndefined();
});

function answer(response: () => Response | Promise<Response>): HttpClient {
  return { fetch: async () => response() };
}

const refused = (body: unknown) => () => new Response(JSON.stringify(body), { status: 401, statusText: "Unauthorized" });
const notFound = (body: string, contentType: string) => () =>
  new Response(body, { status: 404, statusText: "Not Found", headers: { "content-type": contentType } });
const notFoundPage = "<!DOCTYPE html><html lang=\"en\"><head><title>Not Found</title></head><body><h1>404</h1></body></html>";

// What a failed listing says. Every row also keeps the configured models as
// the catalog, as a listing that cannot be used always does.
const failedListings: { name: string; response: () => Response; failure: ProviderModelsResult["failure"] }[] = [
  { name: "a refused listing says why: the status and the provider's own message",
    response: refused({ error: { message: "Invalid API key" } }), failure: { message: "401 Unauthorized: Invalid API key", httpStatus: 401 } },
  // The same words written as a plain string, or as a message beside no error.
  { name: "a refused listing's message may be a plain string",
    response: refused({ error: "Invalid API key" }), failure: { message: "401 Unauthorized: Invalid API key", httpStatus: 401 } },
  { name: "a refused listing's message may stand beside no error",
    response: refused({ message: "Invalid API key" }), failure: { message: "401 Unauthorized: Invalid API key", httpStatus: 401 } },
  { name: "an unreachable provider says what the network said",
    response: () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9"); }, failure: { message: "connect ECONNREFUSED 127.0.0.1:9" } },
  // A gateway's web page for a wrong path is not the provider's words: it came
  // through as "404 Not Found: <!DOCTYPE html><html lang=…", cut at 200.
  { name: "an HTML error page leaves only the status",
    response: notFound(notFoundPage, "text/html; charset=utf-8"), failure: { message: "404 Not Found", httpStatus: 404 } },
  { name: "a page served as text/plain, after blank lines, is still a page",
    response: notFound(`\n  ${notFoundPage}`, "text/plain"), failure: { message: "404 Not Found", httpStatus: 404 } },
  { name: "a plain-text body still says its words",
    response: notFound("route not configured", "text/plain"), failure: { message: "404 Not Found: route not configured", httpStatus: 404 } },
  { name: "a listing that is not a model list says it could not be read",
    response: () => new Response(JSON.stringify({ hello: "world" }), { status: 200, headers: { "content-type": "application/json" } }),
    failure: { message: "The provider's model list could not be read." } }
];

test.each(failedListings)("$name", async ({ response, failure }) => {
  const result = await fetchProviderModels(
    { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", apiKey: "k", models: [{ id: "model-a", input: ["text"] }] },
    { httpClient: answer(response) }
  );
  expect([result.source, result.models.map((m) => m.id), result.failure]).toEqual(["configured", ["model-a"], failure]);
});

test("a long error body is cut to one line of at most 200 characters", async () => {
  const result = await fetchProviderModels(
    { type: "openai", baseURL: "https://api.example/v1", apiKey: "k", models: [] },
    { httpClient: answer(() => new Response("x".repeat(500) + "\nsecond line", { status: 502, statusText: "Bad Gateway" })) }
  );
  expect(result.failure!.message.startsWith("502 Bad Gateway: xxx")).toBe(true);
  expect(result.failure!.message.length).toBeLessThanOrEqual(200);
  expect(result.failure!.message).not.toContain("\n");
  expect(result.failure!.httpStatus).toBe(502);
});

test("no key means no attempt: no failure is reported", async () => {
  const result = await fetchProviderModels(
    { type: "openai", baseURL: "https://api.example/v1", apiKey: "", models: [] },
    { httpClient: neverHttp }
  );
  expect([result.source, result.failure]).toEqual(["configured", undefined]);
});

test("a live listing reports how many models the provider listed", async () => {
  const result = await fetchProviderModels(
    { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", apiKey: "k", models: [{ id: "model-z", input: ["text"] }] },
    { httpClient: jsonHttp({ data: [{ id: "model-a" }, { id: "model-b" }] }) }
  );
  expect([result.source, result.listedCount, result.failure]).toEqual(["live", 2, undefined]);
});

test("Google lists its generateContent models by key header, without the models/ prefix", async () => {
  const capture: { url?: string; headers?: Record<string, string> } = {};
  const result = await fetchProviderModels(
    { type: "google", baseURL: "https://generativelanguage.example/v1beta/", apiKey: "g-key", models: [] },
    { httpClient: jsonHttp({ models: [
      { name: "models/model-a", supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 1048576, thinking: true },
      { name: "models/model-b", supportedGenerationMethods: ["generateContent"], thinking: false },
      { name: "models/embedder-c", supportedGenerationMethods: ["embedContent"] }
    ] }, { capture }) }
  );
  expect(capture.url).toBe("https://generativelanguage.example/v1beta/models?pageSize=1000");
  expect(capture.headers?.["x-goog-api-key"]).toBe("g-key");
  expect(capture.headers?.["authorization"]).toBeUndefined();
  expect([result.source, result.listedCount]).toEqual(["live", 2]);
  expect(result.models.map((m) => [m.id, m.contextLength, m.declared ?? null, m.supportsReasoning ?? null])).toEqual([
    ["model-a", 1048576, { reasoning: true }, null],
    ["model-b", null, { reasoning: false }, false]
  ]);
});

// Kilo's list tags each model with the SDK its own client uses; the listing
// carries the tags for the registry (Settings hands them on), other types none.
test("a Kilo listing carries Kilo's per-model API tags; other types carry none", async () => {
  const payload = { data: [{ id: "vendor/model-a", opencode: { ai_sdk_provider: "anthropic" } }, { id: "vendor/model-b" }, { id: "vendor/model-c", opencode: { ai_sdk_provider: "openai" } }] };
  const kilo = await fetchProviderModels(
    { type: "kilo", baseURL: "https://gateway.example/api/gateway", apiKey: "k-test", models: [] },
    { httpClient: jsonHttp(payload) }
  );
  expect(kilo.kiloApis ? Object.fromEntries(kilo.kiloApis) : null).toEqual({ "vendor/model-a": "messages", "vendor/model-c": "responses" });
  const other = await fetchProviderModels(
    { type: "openai-compatible", baseURL: "https://other.example/v1", apiKey: "x", models: [] },
    { httpClient: jsonHttp(payload) }
  );
  expect(other.kiloApis).toBeUndefined();
});

// Kilo's list depends on the organisation (Kilo's client sends it): Settings
// reads the same list the daily tag refresh does.
test("a Kilo listing sends the connection's organisation, as Kilo's client does", async () => {
  const capture: { url?: string; headers?: Record<string, string> } = {};
  await fetchProviderModels(
    { type: "kilo", baseURL: "https://gateway.example/api/gateway", apiKey: "k-test", organizationId: "org-test", models: [] },
    { httpClient: jsonHttp({ data: [] }, { capture }) }
  );
  expect(capture.headers?.["authorization"]).toBe("Bearer k-test");
  expect(capture.headers?.["x-kilocode-organizationid"]).toBe("org-test");
  const personal: { url?: string; headers?: Record<string, string> } = {};
  await fetchProviderModels(
    { type: "kilo", baseURL: "https://gateway.example/api/gateway", apiKey: "k-test", models: [] },
    { httpClient: jsonHttp({ data: [] }, { capture: personal }) }
  );
  expect(personal.headers?.["x-kilocode-organizationid"]).toBeUndefined();
});
