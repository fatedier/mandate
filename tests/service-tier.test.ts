import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { loadConfig } from "../src/server/config.js";
import { configFileProblems } from "../src/server/config/file-check.js";
import { createAgentProvider } from "../src/server/modules/agent/llm-provider.js";
import { buildProviderConfigs } from "../src/server/runtime/agent-provider-config.js";
import { configJson } from "./helpers/config-file.js";
import { mockFetch } from "./helpers/fetch.js";
import { tempDir } from "./helpers/temp.js";

// A route's step may ask for a service tier. It goes out as chosen, whatever
// the model is called, on the connections whose API has the field, and
// nowhere else.

type Step = { model: string; serviceTier?: string };

/** The worker route's models, built from a config file whose default route
 *  is these steps. */
function route(providers: Record<string, Record<string, unknown>>, steps: Step[]) {
  const dir = tempDir("md-tier-");
  const [first, ...rest] = steps;
  fs.writeFileSync(path.join(dir, "config.json"), configJson({
    models: { default: { ...first, modelFallbacks: rest }, providers }
  }));
  return buildProviderConfigs(loadConfig(dir), "worker");
}

/** The body of the request a step's model sends, caught before it leaves. */
async function requestBody(cfg: ReturnType<typeof buildProviderConfigs>[number]): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  mockFetch((call) => {
    body = JSON.parse(String(call.init?.body ?? "{}"));
    return new Response("stop here", { status: 400 });
  });
  await generateText({ model: createAgentProvider(cfg).model, prompt: "hi", maxRetries: 0 }).catch(() => {});
  return body;
}

const GATEWAY = { type: "openai-compatible", baseURL: "http://127.0.0.1:9/gateway/v1", apiKey: "not-a-real-key" };

test("a custom provider's step sends its tier on Responses and on Chat Completions, whatever the model is called", async () => {
  const steps = route(
    { proxy: { ...GATEWAY, models: [{ id: "gpt-5.5" }, { id: "openai/gpt-5.5" }, { id: "some-model" }, { id: "chat-model", protocol: "chat" }] } },
    [
      { model: "proxy/gpt-5.5", serviceTier: "flex" },
      { model: "proxy/openai/gpt-5.5", serviceTier: "flex" },
      { model: "proxy/some-model", serviceTier: "priority" },
      { model: "proxy/chat-model", serviceTier: "flex" }
    ]
  );
  const sent: unknown[] = [];
  for (const step of steps) sent.push([step.model, (await requestBody(step)).service_tier]);
  expect(sent).toEqual([["gpt-5.5", "flex"], ["openai/gpt-5.5", "flex"], ["some-model", "priority"], ["chat-model", "flex"]]);
});

test("an OpenAI provider's step sends its tier, also for a model the SDK would not send it for", async () => {
  const steps = route(
    { direct: { type: "openai", apiKey: "not-a-real-key", models: [{ id: "gpt-5.5" }, { id: "gpt-4o" }] } },
    [{ model: "direct/gpt-5.5", serviceTier: "priority" }, { model: "direct/gpt-4o", serviceTier: "flex" }]
  );
  expect([(await requestBody(steps[0]!)).service_tier, (await requestBody(steps[1]!)).service_tier]).toEqual(["priority", "flex"]);
});

test("a Gemini step sends its tier in the field Gemini's API reads", async () => {
  const [step] = route(
    { g: { type: "google", apiKey: "not-a-real-key", models: [{ id: "gemini-3-flash" }] } },
    [{ model: "g/gemini-3-flash", serviceTier: "flex" }]
  );
  expect((await requestBody(step!)).serviceTier).toBe("flex");
});

test("a step with no tier sends none", async () => {
  const steps = route(
    {
      proxy: { ...GATEWAY, models: [{ id: "gpt-5.5" }, { id: "some-model" }, { id: "chat-model", protocol: "chat" }] },
      direct: { type: "openai", apiKey: "not-a-real-key", models: [{ id: "gpt-5.5" }] },
      g: { type: "google", apiKey: "not-a-real-key", models: [{ id: "gemini-3-flash" }] }
    },
    [{ model: "proxy/gpt-5.5" }, { model: "proxy/some-model" }, { model: "proxy/chat-model" }, { model: "direct/gpt-5.5" }, { model: "g/gemini-3-flash" }]
  );
  for (const step of steps) {
    const body = await requestBody(step);
    expect([step.model, "service_tier" in body, "serviceTier" in body]).toEqual([step.model, false, false]);
  }
});

test("a tier named on a step that has no such field is not sent: Anthropic, a custom provider's Messages model, Kilo, a decision model", async () => {
  const steps = route(
    {
      claude: { type: "anthropic", apiKey: "not-a-real-key", models: [{ id: "claude-sonnet-4-5" }] },
      // A decision model answers on its provider's Decisions API, which has no tier.
      proxy: { ...GATEWAY, models: [{ id: "messages-model", protocol: "messages" }, { id: "decider", kind: "decision" }] },
      kilo: { type: "kilo", apiKey: "not-a-real-key", models: [{ id: "vendor/some-model" }] }
    },
    [
      { model: "claude/claude-sonnet-4-5", serviceTier: "flex" },
      { model: "proxy/messages-model", serviceTier: "flex" },
      { model: "kilo/vendor/some-model", serviceTier: "flex" },
      { model: "proxy/decider", serviceTier: "flex" }
    ]
  );
  expect(steps.map((step) => step.serviceTier)).toEqual([undefined, undefined, undefined, undefined]);
  for (const step of steps) {
    const body = await requestBody(step);
    expect([step.model, typeof body.model, "service_tier" in body]).toEqual([step.model, "string", false]);
  }
});

test("a Codex step runs at its provider's tier, whatever the step names", () => {
  const steps = route(
    { codex: { type: "codex", serviceTier: "priority" }, plain: { type: "codex" } },
    [{ model: "codex/gpt-5.5", serviceTier: "flex" }, { model: "plain/gpt-5.5", serviceTier: "flex" }]
  );
  expect(steps.map((step) => step.serviceTier)).toEqual(["priority", undefined]);
});

test("a route of its own keeps each step's tier; one that follows the default runs at the default's", () => {
  const dir = tempDir("md-tier-routes-");
  fs.writeFileSync(path.join(dir, "config.json"), configJson({
    models: {
      default: { model: "direct/gpt-5.5", serviceTier: "flex", modelFallbacks: [{ model: "direct/gpt-5-mini", serviceTier: "priority" }] },
      providers: { direct: { type: "openai", apiKey: "not-a-real-key", models: [{ id: "gpt-5.5" }, { id: "gpt-5-mini" }] } }
    },
    agent: {
      managerModel: { model: "direct/gpt-5.5" },
      managerModelFallbacks: [{ model: "direct/gpt-5-mini", serviceTier: "flex" }]
    }
  }));
  const config = loadConfig(dir);
  const tiers = (role: "worker" | "manager") => buildProviderConfigs(config, role).map((step) => [step.model, step.serviceTier]);
  expect(tiers("worker")).toEqual([["gpt-5.5", "flex"], ["gpt-5-mini", "priority"]]);
  expect(tiers("manager")).toEqual([["gpt-5.5", undefined], ["gpt-5-mini", "flex"]]);
  // As Settings reads them back: a tier only where one is set.
  expect([config.models.default.serviceTier, config.models.default.modelFallbacks, config.agent.managerModel, config.agent.managerModelFallbacks]).toEqual([
    "flex",
    [{ model: "direct/gpt-5-mini", reasoningEffort: "provider-default", serviceTier: "priority" }],
    { model: "direct/gpt-5.5", reasoningEffort: "provider-default" },
    [{ model: "direct/gpt-5-mini", reasoningEffort: "provider-default", serviceTier: "flex" }]
  ]);
});

test("the config file takes priority or flex as a step's tier and names anything else", () => {
  expect(configFileProblems({
    models: { default: { model: "p/m", serviceTier: "flex", fallbacks: [{ model: "p/n", serviceTier: "priority" }] } },
    agent: { routes: { worker: { model: "p/m", serviceTier: "" } } }
  })).toEqual([]);
  expect(configFileProblems({
    models: { default: { model: "p/m", serviceTier: "turbo", fallbacks: [{ model: "p/n", serviceTier: 2 }] } },
    agent: { routes: { worker: { model: "p/m", serviceTier: "fast" } } }
  })).toEqual([
    'models.default.serviceTier: must be one of "", priority, flex (it is "turbo")',
    'models.default.fallbacks[0].serviceTier: must be one of "", priority, flex (it is 2)',
    'agent.routes.worker.serviceTier: must be one of "", priority, flex (it is "fast")'
  ]);
});
