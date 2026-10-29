import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { loadConfig } from "../src/server/config.js";
import { buildProviderConfigs } from "../src/server/runtime/agent-provider-config.js";
import { createAgentProvider } from "../src/server/modules/agent/llm-provider.js";
import { PROVIDER_BASE_URL_DEFAULTS } from "../src/shared/settings.js";
import { onCleanup } from "./helpers/cleanup.js";
import { mockFetch } from "./helpers/fetch.js";
import { tempDir } from "./helpers/temp.js";

/** Where the agent's model sends its request, and with which key header,
 *  caught before it leaves. */
async function firstRequest(candidate: ReturnType<typeof createAgentProvider>) {
  let seen = { url: "", key: "" };
  mockFetch((call) => {
    const headers = new Headers(call.init?.headers);
    seen = { url: call.url, key: headers.get("x-api-key") ? "x-api-key" : headers.get("authorization") ? "bearer" : "" };
    return new Response("stop here", { status: 400 });
  });
  await generateText({ model: candidate.model, prompt: "hi", maxRetries: 0 }).catch(() => {});
  return seen;
}

describe("a provider's base URL", () => {
  async function requestUrl(provider: "openai" | "anthropic" | "google" | "openai-compatible", baseURL: string): Promise<string> {
    return (await firstRequest(createAgentProvider({ provider, model: "some-model", apiKey: "not-a-real-key", baseURL, reasoningEffort: "provider-default" }))).url;
  }

  // Anthropic and OpenAI-compatible are covered at their exact URLs: the
  // gateway test below, and the custom provider's protocols.
  for (const provider of ["openai", "google"] as const) {
    test(`an ${provider} provider sends the agent's requests to its configured base URL`, async () => {
      const url = await requestUrl(provider, "http://127.0.0.1:9/gateway/v1");
      expect(url).toStartWith("http://127.0.0.1:9/gateway/v1/");
    });
  }

  test("the base URLs settings fill in by default reach the same endpoints the SDKs call on their own", async () => {
    // What each request went to before configured base URLs were honoured.
    expect({
      openai: await requestUrl("openai", PROVIDER_BASE_URL_DEFAULTS.openai.baseURL),
      anthropic: await requestUrl("anthropic", PROVIDER_BASE_URL_DEFAULTS.anthropic.baseURL),
      google: await requestUrl("google", PROVIDER_BASE_URL_DEFAULTS.google.baseURL)
    }).toEqual({
      openai: "https://api.openai.com/v1/responses",
      anthropic: "https://api.anthropic.com/v1/messages",
      google: "https://generativelanguage.googleapis.com/v1beta/models/some-model:generateContent"
    });
  });

  test("an Anthropic gateway configured without its /v1 is called at /v1, as Settings lists its models", async () => {
    expect({
      bare: await requestUrl("anthropic", "http://127.0.0.1:9/gateway"),
      slash: await requestUrl("anthropic", "http://127.0.0.1:9/gateway/"),
      versioned: await requestUrl("anthropic", "http://127.0.0.1:9/gateway/v1/")
    }).toEqual({
      bare: "http://127.0.0.1:9/gateway/v1/messages",
      slash: "http://127.0.0.1:9/gateway/v1/messages",
      versioned: "http://127.0.0.1:9/gateway/v1/messages"
    });
  });
});

// A custom provider's model is reached over the API its entry names: each
// request below is caught before it leaves, at the URL and with the key
// header that API uses.
describe("a custom provider's model protocol", () => {
  function configWith(models: Array<Record<string, unknown>>) {
    const dir = tempDir("md-protocol-");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: {
        default: { model: "proxy/model-a", modelFallbacks: ["proxy/model-b", "proxy/model-c"] },
        providers: { proxy: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/gateway/v1", apiKey: "not-a-real-key", models } }
      }
    }));
    return loadConfig(dir);
  }

  test("Messages, Chat Completions and Responses each reach their own endpoint of the provider's base URL", async () => {
    const config = configWith([
      { id: "model-a", protocol: "messages" },
      { id: "model-b", protocol: "chat" },
      { id: "model-c" }
    ]);
    const candidates = buildProviderConfigs(config, "worker").map(createAgentProvider);
    const seen: unknown[] = [];
    for (const candidate of candidates) seen.push([candidate.meta.provider, await firstRequest(candidate)]);
    expect(seen).toStrictEqual([
      ["anthropic", { url: "http://127.0.0.1:9/gateway/v1/messages", key: "x-api-key" }],
      ["openai-compatible", { url: "http://127.0.0.1:9/gateway/v1/chat/completions", key: "bearer" }],
      ["openai-compatible", { url: "http://127.0.0.1:9/gateway/v1/responses", key: "bearer" }]
    ]);
    // The configured type stays what Settings shows, and goes with each model:
    // a custom provider's models are told apart from the families they run as.
    expect(config.agent.worker).toMatchObject({ provider: "anthropic", providerType: "openai-compatible", providerName: "proxy" });
    expect(candidates.map((candidate) => candidate.meta.providerType)).toEqual(["openai-compatible", "openai-compatible", "openai-compatible"]);
  });

  test("a Messages model of a custom provider without a key never borrows the Anthropic key from the environment", async () => {
    const previous = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
    onCleanup(() => {
      for (const [key, value] of [["ANTHROPIC_API_KEY", previous.anthropic], ["OPENAI_API_KEY", previous.openai]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    process.env.ANTHROPIC_API_KEY = "someone-elses-anthropic-key";
    delete process.env.OPENAI_API_KEY;
    const dir = tempDir("md-protocol-");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: {
        default: { model: "proxy/model-a" },
        providers: { proxy: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/gateway/v1", models: [{ id: "model-a", protocol: "messages" }] } }
      }
    }));
    const [candidate] = buildProviderConfigs(loadConfig(dir), "worker");
    expect(candidate!.apiKey).toBe("");
    const calls = mockFetch(() => new Response("stop here", { status: 400 }));
    await generateText({ model: createAgentProvider(candidate!).model, prompt: "hi", maxRetries: 0 }).catch(() => {});
    expect(calls).toStrictEqual([]);
  });

  test("a Messages model of a custom provider with no base URL is not configured: no key goes to Anthropic's own host", async () => {
    const previous = process.env.OPENAI_API_KEY;
    onCleanup(() => {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    });
    process.env.OPENAI_API_KEY = "an-openai-key";
    const dir = tempDir("md-protocol-");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: {
        default: { model: "proxy/model-a" },
        providers: { proxy: { type: "openai-compatible", models: [{ id: "model-a", protocol: "messages" }] } }
      }
    }));
    const [candidate] = buildProviderConfigs(loadConfig(dir), "worker");
    expect(candidate!.apiKey).toBe("");
    const calls = mockFetch(() => new Response("stop here", { status: 400 }));
    await generateText({ model: createAgentProvider(candidate!).model, prompt: "hi", maxRetries: 0 }).catch(() => {});
    expect(calls).toStrictEqual([]);
  });
});
