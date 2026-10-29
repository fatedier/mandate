import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { loadConfig } from "../src/server/config.js";
import { clearKiloModelApis, replaceKiloModelApis } from "../src/server/config/kilo-model-apis.js";
import { resolveModelSelection } from "../src/server/config/model-resolution.js";
import { createAiSdkLanguageModel } from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { candidateCallOptions } from "../src/server/modules/agent/wake-llm-attempts.js";
import { tempDir } from "./helpers/temp.js";

// A Kilo model is built with the SDK of the API Kilo tags it with, the way
// Kilo's own client builds it: Messages, Responses, or Chat through
// OpenRouter's SDK; all at `${base}/v1` with the Bearer key and the
// organisation. The Chat model sends no Anthropic cache marks and takes the
// effort in OpenRouter's own parameter.

afterEach(() => clearKiloModelApis());

const BASE = "https://gateway.example/api/gateway";
const ANSWERS: Record<string, unknown> = {
  messages: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
  responses: { id: "resp_1", object: "response", created_at: 0, status: "completed", model: "m", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  "chat/completions": { id: "c_1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
};

function capture() {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const url = String(input);
    seen.push({ url, headers, body: JSON.parse(String(init?.body ?? "{}")) });
    const kind = Object.keys(ANSWERS).find((k) => url.endsWith(`/${k}`))!;
    return new Response(JSON.stringify(ANSWERS[kind]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetch };
}

function kiloModel(api: "messages" | "responses" | "chat", fetch: typeof globalThis.fetch, baseURL = BASE) {
  return createAiSdkLanguageModel({
    provider: api === "messages" ? "anthropic" : api === "responses" ? "openai-compatible" : "kilo",
    providerType: "kilo",
    providerName: "kilo",
    model: "vendor/model",
    apiKey: "k-test",
    baseURL,
    organizationId: "org-test",
    fetch
  })!;
}

for (const [api, tail] of [["messages", "/api/gateway/v1/messages"], ["responses", "/api/gateway/v1/responses"], ["chat", "/api/gateway/v1/chat/completions"]] as const) {
  test(`${api} path: Kilo's /v1 address, Bearer key, organisation`, async () => {
    const { seen, fetch } = capture();
    await generateText({ model: kiloModel(api, fetch), prompt: "hi" });
    expect(seen[0]!.url.endsWith(tail)).toBe(true);
    expect(seen[0]!.headers.authorization).toBe("Bearer k-test");
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.headers["x-kilocode-organizationid"]).toBe("org-test");
  });
}

test("a base already ending in /v1 is not doubled", async () => {
  const { seen, fetch } = capture();
  await generateText({ model: kiloModel("chat", fetch, `${BASE}/v1`), prompt: "hi" });
  expect(seen[0]!.url).toBe(`${BASE}/v1/chat/completions`);
});

test("chat drops anthropic provider options: no cache_control leaves", async () => {
  const { seen, fetch } = capture();
  await generateText({
    model: kiloModel("chat", fetch),
    system: { role: "system", content: "Be brief.", providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } } as never,
    messages: [{ role: "user", content: "hi", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }]
  });
  expect(JSON.stringify(seen[0]!.body)).not.toContain("cache_control");
});

test("chat maps effort into OpenRouter's reasoning parameter", async () => {
  const sent = async (reasoning?: string) => {
    const { seen, fetch } = capture();
    await generateText({ model: kiloModel("chat", fetch), prompt: "hi", ...(reasoning ? { reasoning } : {}) } as never);
    return seen[0]!.body.reasoning;
  };
  expect(await sent("max")).toEqual({ effort: "xhigh" });
  expect(await sent("low")).toEqual({ effort: "low" });
  expect(await sent("none")).toEqual({ effort: "none" });
  expect(await sent("provider-default")).toBeUndefined();
  expect(await sent()).toBeUndefined();
});

// Kilo (like OpenRouter) writes Claude versions with a dot; the Anthropic SDK
// reads a model's output cap and thinking rules from the dashed name. Read as
// unknown, Haiku 4.5 at xhigh would get max_tokens 128000, which Kilo refuses;
// read as Opus 5, Opus 5.5 at "none" would get thinking disabled, which
// Opus 5.5 does not take.
test("a dotted Claude id is read as its dashed name and sent as configured", async () => {
  const sent = async (model: string, reasoning: string, provider: { providerType?: "kilo"; baseURL: string }) => {
    const { seen, fetch } = capture();
    const m = createAiSdkLanguageModel({ provider: "anthropic", providerName: "gw", model, apiKey: "k-test", fetch, ...provider })!;
    await generateText({ model: m, prompt: "hi", reasoning } as never);
    return { body: seen[0]!.body, modelId: (m as { modelId: string }).modelId };
  };
  const haiku = await sent("anthropic/claude-haiku-4.5", "xhigh", { providerType: "kilo", baseURL: BASE });
  expect(haiku.body.model).toBe("anthropic/claude-haiku-4.5");
  expect(haiku.body.max_tokens).toBe(64000);
  expect((haiku.body.thinking as { type: string }).type).toBe("enabled");
  expect(haiku.modelId).toBe("anthropic/claude-haiku-4.5");
  const opus = await sent("anthropic/claude-opus-5.5", "none", { providerType: "kilo", baseURL: BASE });
  expect(opus.body.model).toBe("anthropic/claude-opus-5.5");
  expect(opus.body.thinking).toBeUndefined();
  // Any Messages connection, not only Kilo: a gateway with OpenRouter-style names.
  const other = await sent("anthropic/claude-sonnet-4.5", "xhigh", { baseURL: "https://gw.example/v1" });
  expect(other.body.model).toBe("anthropic/claude-sonnet-4.5");
  expect(other.body.max_tokens).toBe(64000);
});

test("an id whose dashed form the SDK does not know is left as it is", async () => {
  const { seen, fetch } = capture();
  const m = createAiSdkLanguageModel({ provider: "anthropic", providerType: "kilo", providerName: "kilo", model: "vendor/model-2.5", apiKey: "k-test", baseURL: BASE, fetch })!;
  await generateText({ model: m, prompt: "hi" });
  expect(seen[0]!.body.model).toBe("vendor/model-2.5");
  expect((m as { modelId: string }).modelId).toBe("vendor/model-2.5");
});

test("a Kilo model's family follows its API; an untagged one stays Kilo", () => {
  replaceKiloModelApis("kilo", new Map([["vendor/claude-x", "messages"], ["vendor/gpt-x", "responses"]]));
  const dir = tempDir("md-kilo-family-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ models: { providers: { kilo: { type: "kilo", apiKey: "k-test", models: [{ id: "vendor/claude-x" }, { id: "vendor/gpt-x" }, { id: "vendor/other-x" }] } } } }));
  const cfg = loadConfig(dir);
  const resolve = (model: string) => resolveModelSelection(cfg, { model, reasoningEffort: "medium" });
  // Anthropic family: Mandate's cache marks and Anthropic options, as for any Claude.
  expect(resolve("kilo/vendor/claude-x")).toMatchObject({ provider: "anthropic", providerType: "kilo", api: "messages" });
  expect(resolve("kilo/vendor/gpt-x")).toMatchObject({ provider: "openai-compatible", providerType: "kilo", api: "responses" });
  expect(resolve("kilo/vendor/other-x")).toMatchObject({ provider: "kilo", providerType: "kilo", api: "chat" });
});

test("a Kilo candidate's wake steps carry the session headers", () => {
  const options = candidateCallOptions(
    { model: "vendor/model" as never, meta: { provider: "anthropic", providerType: "kilo", model: "vendor/model" } } as never,
    "thr_test",
    { askSummary: false }
  );
  expect(options.headers).toEqual({ "x-session-id": "thr_test", "x-session-affinity": "thr_test" });
});
