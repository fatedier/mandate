import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { streamText } from "ai";
import { loadConfig } from "../src/server/config/load-config.js";
import type { Config } from "../src/server/config/types.js";
import { createAgentProvider, snapshotKey, type AgentProviderConfig } from "../src/server/modules/agent/llm-provider.js";
import { createAgentRuntimeProviders } from "../src/server/runtime/agent-providers.js";
import { createAgentRuntimeLlmRecorders } from "../src/server/runtime/agent-llm-recorders.js";
import { createAgentModelRouter } from "../src/server/runtime/agent-model-router.js";
import { mockFetch } from "./helpers/fetch.js";
import { tempDir } from "./helpers/temp.js";
import { testStore } from "./helpers/test-store.js";
import { configJson } from "./helpers/config-file.js";

// A model candidate keeps the plain config it was built from, so another
// thread can build the same model: the same request, byte for byte. A model
// that needs this thread's own fetch (Codex's sign-in) keeps none.

const CONFIGS: Array<[string, AgentProviderConfig]> = [
  ["anthropic", { provider: "anthropic", model: "claude-test", apiKey: "k-a", baseURL: "https://a.example/v1", reasoningEffort: "high", supportsReasoning: true }],
  ["openai responses", { provider: "openai", model: "gpt-test", apiKey: "k-o", baseURL: "https://o.example/v1", reasoningEffort: "medium", supportsReasoning: true }],
  ["custom chat", { provider: "openai-compatible", providerType: "openai-compatible", providerName: "proxy", model: "model-chat", apiKey: "k-p", baseURL: "https://p.example/v1", openaiModelApi: "chat", reasoningEffort: "provider-default" }],
  ["custom open responses", { provider: "openai-compatible", providerType: "openai-compatible", providerName: "proxy", model: "vendor/model-r", apiKey: "k-p", baseURL: "https://p.example/v1", reasoningEffort: "high", supportsReasoning: true }],
  ["google", { provider: "google", model: "gemini-test", apiKey: "k-g", baseURL: "https://g.example/v1beta", reasoningEffort: "provider-default" }],
  ["kilo chat", { provider: "kilo", providerType: "kilo", model: "vendor/model-k", apiKey: "k-k", baseURL: "https://kilo.example/api", organizationId: "org-1", reasoningEffort: "low" }],
  ["kilo messages", { provider: "anthropic", providerType: "kilo", model: "claude-test", apiKey: "k-k", baseURL: "https://kilo.example/api", organizationId: "org-1", reasoningEffort: "high", supportsReasoning: true }]
];

/** The first request a model sends for a fixed prompt, as it leaves. */
async function firstRequest(model: ReturnType<typeof createAgentProvider>["model"]) {
  const calls = mockFetch(() => new Response("stop here", { status: 400 }));
  const stream = streamText({ model, system: "Be brief.", prompt: "Summarize the plan.", maxRetries: 0, providerOptions: { openai: { store: false } } });
  await Promise.resolve(stream.consumeStream()).catch(() => {});
  await Promise.resolve(stream.text).catch(() => {});
  const call = calls[0]!;
  return { url: call.url, headers: [...new Headers(call.init?.headers).entries()].sort(), body: String(call.init?.body) };
}

for (const [label, cfg] of CONFIGS) {
  test(`${label}: the model rebuilt from its snapshot sends the same request`, async () => {
    const original = createAgentProvider(cfg);
    expect(original.construction).toEqual(cfg);
    expect(Object.isFrozen(original.construction)).toBe(true);
    const rebuilt = createAgentProvider(original.construction!);
    expect(await firstRequest(rebuilt.model)).toEqual(await firstRequest(original.model));
    expect(snapshotKey(rebuilt.construction!)).toBe(snapshotKey(original.construction!));
  });
}

test("the snapshot's key follows its content, not its key order", () => {
  const a = createAgentProvider(CONFIGS[0]![1]).construction!;
  const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
  expect(snapshotKey(reordered)).toBe(snapshotKey(a));
  expect(snapshotKey({ ...a, model: "claude-other" })).not.toBe(snapshotKey(a));
});

test("a model that needs this thread's fetch, or Codex's sign-in, keeps no snapshot", () => {
  expect(createAgentProvider({ ...CONFIGS[0]![1], fetch: globalThis.fetch }).construction).toBeUndefined();
  expect(createAgentProvider({ provider: "codex", model: "gpt-test", reasoningEffort: "provider-default" }).construction).toBeUndefined();
  expect(createAgentProvider({ provider: "anthropic", model: "", reasoningEffort: "provider-default" }).construction).toBeUndefined();
});

function configWith(managerModel: string): Config {
  const dir = tempDir("md-snapshot-config-");
  fs.writeFileSync(path.join(dir, "config.json"), configJson({
    models: {
      default: { model: "main/model-a" },
      providers: { main: { type: "openai-compatible", apiKey: "main-key", baseURL: "https://main.example/v1", models: [{ id: "model-a", input: ["text"] }, { id: "model-b", input: ["text"] }] } }
    },
    agent: { managerModel, managerModelFallbacks: [], logRequests: "metadata" }
  }));
  return loadConfig(dir);
}

test("a step's candidates carry their snapshots, and one taken before a reload keeps its own", () => {
  let config = configWith("main/model-a");
  let providers = createAgentRuntimeProviders(config);
  const store = testStore(tempDir("md-snapshot-store-"));
  const router = createAgentModelRouter({
    config: () => config,
    providers: () => providers,
    recorders: () => createAgentRuntimeLlmRecorders({ config, store }),
    store,
    scopeOf: () => "manager",
    parentOf: () => undefined
  });
  const before = router.llmForThread("thr_manager").candidates[0]!;
  expect(before.construction?.model).toBe("model-a");
  config = configWith("main/model-b");
  providers = createAgentRuntimeProviders(config);
  const after = router.llmForThread("thr_manager").candidates[0]!;
  expect([before.construction?.model, after.construction?.model]).toEqual(["model-a", "model-b"]);
  store.db.close();
});
