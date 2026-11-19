import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../src/server/config.js";
import { toolReviewAvailable, toolReviewScreenChain, toolReviewSecondLookChain } from "../src/server/config/model-resolution.js";
import { applySettingsConfigPatch } from "../src/server/modules/settings/config-schema.js";
import { buildSettingsConfigPayload } from "../src/server/modules/settings/settings-payload.js";
import { mountSettingsRoutes } from "../src/server/modules/settings/settings-routes.js";
import { tempDir } from "./helpers/temp.js";
import { setStartOverrides } from "../src/server/config/start-overrides.js";
import { configFileProblems } from "../src/server/config/file-check.js";
import { configJson } from "./helpers/config-file.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

// The tool-call review is off until the user turns it on. Its screen runs on
// its own route, else on Decisions while Decisions is on; its second look on
// its own route's chat models, else on the chat models in Decisions. Without
// a second look it cannot hold anything back, so it cannot be turned on.

type Raw = Record<string, unknown>;
const step = (model: string) => ({ model, reasoningEffort: "provider-default" });
const BASE = applySettingsConfigPatch({}, {
  models: {
    default: { model: "gw/deepseek/deepseek-flash", reasoningEffort: "medium" },
    providers: {
      gw: {
        type: "openai-compatible", baseURL: "https://gw.example/v1", apiKey: "sk-test",
        models: [
          { id: "vendor/judge-1", input: ["text"], kind: "decision" },
          { id: "deepseek/deepseek-flash", input: ["text"] },
          { id: "openai/gpt-6-luna", input: ["text"] }
        ]
      }
    }
  }
});
const DECISIONS = { decisionsEnabled: true, decisionsModel: step("gw/vendor/judge-1"), decisionsModelFallbacks: [step("gw/deepseek/deepseek-flash")] };
const JUDGE_ONLY = { decisionsEnabled: true, decisionsModel: step("gw/vendor/judge-1") };

function load(raw: Raw) {
  const dir = tempDir("md-tool-review-config-");
  fs.writeFileSync(path.join(dir, "config.json"), configJson(raw));
  return loadConfig(dir);
}
const withAgent = (agent: Raw) => applySettingsConfigPatch(BASE, { agent });
const refs = (chain: { modelRef: string }[]) => chain.map((r) => r.modelRef);

test("the screen falls back to Decisions and the second look to Decisions' chat models", () => {
  const onDecisions = load(withAgent(DECISIONS));
  expect(refs(toolReviewScreenChain(onDecisions))).toEqual(["gw/vendor/judge-1", "gw/deepseek/deepseek-flash"]);
  expect(refs(toolReviewSecondLookChain(onDecisions))).toEqual(["gw/deepseek/deepseek-flash"]);
  expect(toolReviewAvailable(onDecisions)).toBe(true);

  // Decisions off keeps its chain and lends it to no one.
  const decisionsOff = load(withAgent({ ...DECISIONS, decisionsEnabled: false }));
  expect([toolReviewScreenChain(decisionsOff), toolReviewSecondLookChain(decisionsOff), toolReviewAvailable(decisionsOff)]).toEqual([[], [], false]);

  // Their own routes win; the second look keeps only its chat models.
  const own = load(withAgent({
    ...DECISIONS,
    toolReviewScreenModel: step("gw/openai/gpt-6-luna"),
    toolReviewSecondLookModel: step("gw/vendor/judge-1"),
    toolReviewSecondLookModelFallbacks: [step("gw/openai/gpt-6-luna")]
  }));
  expect(refs(toolReviewScreenChain(own))).toEqual(["gw/openai/gpt-6-luna"]);
  expect(refs(toolReviewSecondLookChain(own))).toEqual(["gw/openai/gpt-6-luna"]);
});

const ENV_KEYS = ["MANDATE_DATA_DIR"] as const;
let savedEnv: Record<string, string | undefined> = {};
let dir: string;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  dir = tempDir("md-tool-review-settings-");
  process.env.MANDATE_DATA_DIR = dir;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function settingsApp(raw: Raw) {
  fs.writeFileSync(path.join(dir, "config.json"), configJson(raw));
  const app = new Hono();
  mountSettingsRoutes(app);
  const post = (agent: Raw) => app.request("/api/settings/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent })
  });
  // The saved file in the app's flat keys (its grouped layout is tested in config-file-layout).
  const saved = () => flatFromFile(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))) as { agent?: Raw };
  return { app, post, saved };
}

test("with no chat model anywhere the review cannot be turned on", async () => {
  const { post, saved } = settingsApp(withAgent(JUDGE_ONLY));
  const refused = await post({ toolReviewEnabled: true });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ ok: false, error: "Set a model for the tool-call review's second look in Routing first." });
  expect(saved().agent?.toolReviewEnabled).toBeUndefined();

  // Once a chat model is there for it, it can.
  expect((await post({ toolReviewSecondLookModel: step("gw/deepseek/deepseek-flash") })).status).toBe(200);
  expect((await post({ toolReviewEnabled: true })).status).toBe(200);
  expect(saved().agent?.toolReviewEnabled).toBe(true);
});

test("a review saved as on whose second look has gone reads as off, and is saved off by the next save", async () => {
  const { app, post, saved } = settingsApp(withAgent({ ...JUDGE_ONLY, toolReviewEnabled: true }));
  // What Settings shows is what the file will say: off.
  expect((await (await app.request("/api/settings/config")).json()).agent.toolReviewEnabled).toBe(false);
  const kept = await post({ toolReviewRules: "Ask me before anything touches production." });
  expect(kept.status).toBe(200);
  expect([saved().agent?.toolReviewEnabled, saved().agent?.toolReviewRules]).toEqual([false, "Ask me before anything touches production."]);
});

test("taking away the second look's model turns the review off in the file", async () => {
  const { post, saved } = settingsApp(withAgent({ ...JUDGE_ONLY, toolReviewSecondLookModel: step("gw/deepseek/deepseek-flash") }));
  expect((await post({ toolReviewEnabled: true })).status).toBe(200);
  expect(saved().agent?.toolReviewEnabled).toBe(true);
  // The route goes: with it the only chat model the review had.
  expect((await post({ toolReviewSecondLookModel: null })).status).toBe(200);
  expect(saved().agent?.toolReviewEnabled).toBe(false);
});

test("rules and the switch round-trip through the settings payload", async () => {
  const { app, post } = settingsApp(withAgent(DECISIONS));
  const rules = "Ask me before anything touches the production cluster.\nPushing to my own branches is fine.";
  const saved = await post({ toolReviewEnabled: true, toolReviewRules: `  ${rules}\n`, toolReviewScreenModel: step("gw/openai/gpt-6-luna") });
  expect(saved.status).toBe(200);
  const agent = (await (await app.request("/api/settings/config")).json()).agent;
  expect([agent.toolReviewEnabled, agent.toolReviewRules, agent.toolReviewScreenModel.model, agent.toolReviewSecondLookModel.model])
    .toEqual([true, rules, "gw/openai/gpt-6-luna", ""]);
  expect([agent.modelOverrides.toolReviewScreen, agent.modelOverrides.toolReviewSecondLook]).toEqual([true, false]);

  // Off again, and the rules cleared, without touching anything else.
  expect((await post({ toolReviewEnabled: false, toolReviewRules: null })).status).toBe(200);
  const after = (await (await app.request("/api/settings/config")).json()).agent;
  expect([after.toolReviewEnabled, after.toolReviewRules, after.toolReviewScreenModel.model]).toEqual([false, "", "gw/openai/gpt-6-luna"]);
});

test("an old config without these keys loads with the review off", () => {
  const config = load(withAgent(DECISIONS));
  expect([config.agent.toolReviewEnabled, config.agent.toolReviewRules, config.agent.toolReviewScreenRouteSet, config.agent.toolReviewSecondLookRouteSet])
    .toEqual([false, "", false, false]);
  const agent = buildSettingsConfigPayload(false, { config }).agent;
  expect([agent.toolReviewEnabled, agent.toolReviewRules, agent.modelOverrides.toolReviewScreen, agent.modelOverrides.toolReviewSecondLook])
    .toEqual([false, "", false, false]);
  // A hand edit's "true" is refused, not read as on.
  const raw = withAgent(DECISIONS);
  expect(configFileProblems(fileFromFlat({ ...raw, agent: { ...(raw.agent as Raw), toolReviewEnabled: "true" } })))
    .toEqual(['agent.toolReview.enabled: must be true or false (it is "true")']);
});

test("checking whether the review can run writes nothing a serve flag overrides into the file", async () => {
  setStartOverrides({ logLevel: "debug" });
  try {
    const { post, saved } = settingsApp({ ...withAgent({ ...JUDGE_ONLY, toolReviewSecondLookModel: step("gw/deepseek/deepseek-flash"), toolReviewEnabled: true }), logging: { level: "info" } });
    expect((await post({ toolReviewRules: "Ask before production changes." })).status).toBe(200);
    expect((saved() as { logging?: { level?: string } }).logging?.level).toBe("info");
  } finally {
    setStartOverrides({});
  }
});
