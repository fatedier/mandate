import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { resolveModelSelection } from "../src/server/config/model-resolution.js";
import { applySettingsConfigPatch } from "../src/server/modules/settings/config-schema.js";
import { buildSettingsConfigPayload } from "../src/server/modules/settings/settings-payload.js";
import { searchApiOf } from "../src/server/modules/web/kinds/model-search.js";
import { tempDir } from "./helpers/temp.js";

// A model's kind: a decision model answers typed questions over OpenRouter's
// Decisions API instead of chatting. Only a custom provider can serve one.

const providerPatch = (type: string, models: unknown[]) => ({
  models: { providers: { gw: { type, baseURL: "https://gw.example/v1", apiKey: "sk-test", models } } }
});
const JUDGE = { id: "vendor/judge-1", input: ["text"], kind: "decision" };

function loadFile(raw: unknown) {
  const dir = tempDir("md-model-kind-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(raw));
  return loadConfig(dir);
}

test("a custom provider's model keeps kind decision through the patch, the load and the settings payload", () => {
  const raw = applySettingsConfigPatch({}, providerPatch("openai-compatible", [JUDGE, { id: "deepseek/deepseek-flash", input: ["text"] }]));
  const config = loadFile(raw);
  const models = config.models.providers.gw!.models;
  expect(models.map((m) => m.kind)).toStrictEqual(["decision", undefined]);
  expect(resolveModelSelection(config, { model: "gw/vendor/judge-1", reasoningEffort: "medium" }).kind).toBe("decision");
  expect(resolveModelSelection(config, { model: "gw/deepseek/deepseek-flash", reasoningEffort: "medium" }).kind).toBeUndefined();
  const payload = buildSettingsConfigPayload(false, { config });
  expect(payload.models.providers.gw!.models[0]!.kind).toBe("decision");
});

test("kind is dropped on a provider that is not a custom one, by the patch and by the load", () => {
  const raw = applySettingsConfigPatch({}, providerPatch("openai", [JUDGE])) as { models: { providers: { gw: { models: Array<Record<string, unknown>> } } } };
  expect("kind" in raw.models.providers.gw.models[0]!).toBe(false);
  // A file edited by hand keeps it no better.
  const config = loadFile({ models: { providers: { gw: { type: "openai", apiKey: "sk-test", models: [JUDGE] } } } });
  expect(config.models.providers.gw!.models[0]!.kind).toBeUndefined();
});

test("a kind other than decision is refused", () => {
  expect(() => applySettingsConfigPatch({}, providerPatch("openai-compatible", [{ ...JUDGE, kind: "chatty" }])))
    .toThrow(/models\[\]\.kind must be decision/);
});

test("kind null makes the model a chat model again", () => {
  const raw = applySettingsConfigPatch({}, providerPatch("openai-compatible", [{ ...JUDGE, kind: null }])) as { models: { providers: { gw: { models: Array<Record<string, unknown>> } } } };
  expect("kind" in raw.models.providers.gw.models[0]!).toBe(false);
});

test("a decision model cannot search: model search neither lists nor uses it", () => {
  const config = loadFile({ models: { providers: { gw: { type: "openai-compatible", baseURL: "https://gw.example/v1", apiKey: "sk-test", models: [JUDGE, { id: "chat-1", input: ["text"] }] } } } });
  const api = (model: string) => searchApiOf(resolveModelSelection(config, { model, reasoningEffort: "low" }));
  expect([api("gw/vendor/judge-1"), api("gw/chat-1")]).toEqual([null, "responses"]);
});
