import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { managerRequestCheckChain, managerStopCheckChain, memoryRepeatCheckChain } from "../src/server/config/model-resolution.js";
import { applySettingsConfigPatch } from "../src/server/modules/settings/config-schema.js";
import { buildSettingsConfigPayload } from "../src/server/modules/settings/settings-payload.js";
import { tempDir } from "./helpers/temp.js";

// Decisions: the models Mandate asks for quick judgements, chat and decision
// models mixed. Manager request check runs on its own route when that is set, else
// on Decisions while Decisions is on; otherwise it is off. Unset, Decisions
// is no one's chain: it never takes the Default route's.

type Raw = Record<string, unknown>;
const step = (model: string) => ({ model, reasoningEffort: "provider-default" });
const BASE = applySettingsConfigPatch({}, {
  models: {
    default: { model: "gw/deepseek/deepseek-flash", reasoningEffort: "medium", modelFallbacks: [step("gw/openai/gpt-6-luna")] },
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
const DECISIONS = { decisionsModel: step("gw/vendor/judge-1"), decisionsModelFallbacks: [step("gw/deepseek/deepseek-flash")] };
const OWN = { managerRequestCheckModel: step("gw/openai/gpt-6-luna") };

function load(raw: Raw) {
  const dir = tempDir("md-judgement-routes-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(raw));
  return loadConfig(dir);
}
const withAgent = (agent: Raw, raw: Raw = BASE) => applySettingsConfigPatch(raw, { agent });
const refs = (raw: Raw) => managerRequestCheckChain(load(raw)).map((r) => r.modelRef);
const STOP_OWN = { managerStopCheckModel: step("gw/openai/gpt-6-luna") };
const stopRefs = (raw: Raw) => managerStopCheckChain(load(raw)).map((r) => r.modelRef);

test("nothing set: manager request check is off, and Decisions does not take the Default route", () => {
  const config = load(BASE);
  expect(managerRequestCheckChain(config)).toEqual([]);
  const agent = buildSettingsConfigPayload(false, { config }).agent;
  expect([agent.decisionsEnabled, agent.decisionsModel.model, agent.decisionsModelFallbacks, agent.modelOverrides.managerRequestCheck])
    .toEqual([false, "", [], false]);
});

const chains: { name: string; agent: Raw; chain: string[] }[] = [
  {
    name: "Decisions on, Manager request check unset: manager request check runs on Decisions' chain",
    agent: { decisionsEnabled: true, ...DECISIONS },
    chain: ["gw/vendor/judge-1", "gw/deepseek/deepseek-flash"]
  },
  { name: "Decisions off keeps its chain and judges nothing", agent: { decisionsEnabled: false, ...DECISIONS }, chain: [] },
  { name: "Manager request check's own route wins while Decisions is on", agent: { decisionsEnabled: true, ...DECISIONS, ...OWN }, chain: ["gw/openai/gpt-6-luna"] },
  { name: "Manager request check's own route runs while Decisions is off", agent: { decisionsEnabled: false, ...DECISIONS, ...OWN }, chain: ["gw/openai/gpt-6-luna"] }
];
test.each(chains)("$name", ({ agent, chain }) => {
  expect(refs(withAgent(agent))).toEqual(chain);
});

test("a Decisions chain keeps each step's kind", () => {
  const chain = managerRequestCheckChain(load(withAgent({ decisionsEnabled: true, ...DECISIONS })));
  expect(chain.map((r) => r.kind)).toStrictEqual(["decision", undefined]);
});

test("Decisions switched off still shows its chain in Settings", () => {
  const agent = buildSettingsConfigPayload(false, { config: load(withAgent({ decisionsEnabled: false, ...DECISIONS })) }).agent;
  expect([agent.decisionsEnabled, agent.decisionsModel.model, agent.decisionsModelFallbacks.map((s) => s.model)])
    .toEqual([false, "gw/vendor/judge-1", ["gw/deepseek/deepseek-flash"]]);
});

test("Manager request check's own route is reported set, and null takes it off again", () => {
  const set = withAgent({ decisionsEnabled: true, ...DECISIONS, ...OWN });
  expect(buildSettingsConfigPayload(false, { config: load(set) }).agent.modelOverrides.managerRequestCheck).toBe(true);
  const unset = withAgent({ managerRequestCheckModel: null, managerRequestCheckModelFallbacks: null }, set);
  expect(buildSettingsConfigPayload(false, { config: load(unset) }).agent.modelOverrides.managerRequestCheck).toBe(false);
  expect(refs(unset)).toEqual(["gw/vendor/judge-1", "gw/deepseek/deepseek-flash"]);
});

test("decisionsEnabled must be a boolean", () => {
  expect(() => withAgent({ decisionsEnabled: "yes" })).toThrow(/decisionsEnabled must be a boolean/);
});

// Each use of Decisions has its own On: Manager request check's is on unless
// switched off, so nothing changes for anyone; Manager stop check's is off until the
// user turns it on, since it is new spending.
test("manager stop check is off by default and runs on Decisions once on", () => {
  expect(stopRefs(withAgent({ decisionsEnabled: true, ...DECISIONS }))).toEqual([]);
  expect(stopRefs(withAgent({ decisionsEnabled: true, ...DECISIONS, managerStopCheckEnabled: true }))).toEqual(["gw/vendor/judge-1", "gw/deepseek/deepseek-flash"]);
  // Its own route wins, and runs while Decisions is off.
  expect(stopRefs(withAgent({ decisionsEnabled: true, ...DECISIONS, ...STOP_OWN, managerStopCheckEnabled: true }))).toEqual(["gw/openai/gpt-6-luna"]);
  expect(stopRefs(withAgent({ decisionsEnabled: false, ...DECISIONS, ...STOP_OWN, managerStopCheckEnabled: true }))).toEqual(["gw/openai/gpt-6-luna"]);
  // Off, nothing runs, whatever its route; on with no route and Decisions off, nothing either.
  expect(stopRefs(withAgent({ decisionsEnabled: true, ...DECISIONS, ...STOP_OWN }))).toEqual([]);
  expect(stopRefs(withAgent({ decisionsEnabled: false, ...DECISIONS, managerStopCheckEnabled: true }))).toEqual([]);
});

test("manager request check stays on unless switched off", () => {
  expect(refs(withAgent({ decisionsEnabled: true, ...DECISIONS }))).toHaveLength(2);
  expect(refs(withAgent({ decisionsEnabled: true, ...DECISIONS, managerRequestCheckEnabled: true }))).toHaveLength(2);
  expect(refs(withAgent({ decisionsEnabled: true, ...DECISIONS, managerRequestCheckEnabled: false }))).toEqual([]);
  expect(refs(withAgent({ decisionsEnabled: true, ...DECISIONS, ...OWN, managerRequestCheckEnabled: false }))).toEqual([]);
});

test("the flags and the route round-trip through settings", () => {
  const nothing = buildSettingsConfigPayload(false, { config: load(BASE) }).agent;
  expect([nothing.managerRequestCheckEnabled, nothing.managerStopCheckEnabled, nothing.modelOverrides.managerStopCheck, nothing.managerStopCheckModel.model, nothing.managerStopCheckModelFallbacks])
    .toEqual([true, false, false, "", []]);
  const set = withAgent({
    decisionsEnabled: true, ...DECISIONS, ...STOP_OWN, managerStopCheckModelFallbacks: [step("gw/deepseek/deepseek-flash")],
    managerStopCheckEnabled: true, managerRequestCheckEnabled: false
  });
  const agent = buildSettingsConfigPayload(false, { config: load(set) }).agent;
  expect([agent.managerRequestCheckEnabled, agent.managerStopCheckEnabled, agent.modelOverrides.managerStopCheck, agent.managerStopCheckModel.model, agent.managerStopCheckModelFallbacks.map((s) => s.model)])
    .toEqual([false, true, true, "gw/openai/gpt-6-luna", ["gw/deepseek/deepseek-flash"]]);
  const unset = withAgent({ managerStopCheckModel: null, managerStopCheckModelFallbacks: null, managerRequestCheckEnabled: null, managerStopCheckEnabled: null }, set);
  const back = buildSettingsConfigPayload(false, { config: load(unset) }).agent;
  expect([back.modelOverrides.managerStopCheck, back.managerRequestCheckEnabled, back.managerStopCheckEnabled]).toEqual([false, true, false]);
  expect(() => withAgent({ managerStopCheckEnabled: "yes" })).toThrow(/managerStopCheckEnabled must be a boolean/);
  expect(() => withAgent({ managerRequestCheckEnabled: 1 })).toThrow(/managerRequestCheckEnabled must be a boolean/);
});

// A hand edit can leave anything there: only an explicit false turns request
// check off, and only an explicit true turns manager stop check on.
test("a flag that is not a boolean leaves each use as it defaults", () => {
  const raw = { ...withAgent({ decisionsEnabled: true, ...DECISIONS }) } as Raw;
  const agent = { ...(raw.agent as Raw), managerRequestCheckEnabled: "maybe", managerStopCheckEnabled: "maybe" };
  const config = load({ ...raw, agent });
  expect([managerRequestCheckChain(config).length, managerStopCheckChain(config).length]).toEqual([2, 0]);
});

// Memory repeat check, a use of Decisions as manager stop check is: new
// spending, so off until switched on, then on Decisions unless its own route
// is set; its flag and route round-trip through settings.
test("memory repeat check is off by default, runs on Decisions once on, and its own route wins", () => {
  const repeatRefs = (raw: Raw) => memoryRepeatCheckChain(load(raw)).map((r) => r.modelRef);
  const REPEAT_OWN = { memoryRepeatCheckModel: step("gw/openai/gpt-6-luna") };
  expect(repeatRefs(withAgent({ decisionsEnabled: true, ...DECISIONS }))).toEqual([]);
  expect(repeatRefs(withAgent({ decisionsEnabled: true, ...DECISIONS, memoryRepeatCheckEnabled: true }))).toEqual(["gw/vendor/judge-1", "gw/deepseek/deepseek-flash"]);
  expect(repeatRefs(withAgent({ decisionsEnabled: false, ...DECISIONS, ...REPEAT_OWN, memoryRepeatCheckEnabled: true }))).toEqual(["gw/openai/gpt-6-luna"]);
  expect(repeatRefs(withAgent({ decisionsEnabled: true, ...DECISIONS, ...REPEAT_OWN }))).toEqual([]);
  expect(repeatRefs(withAgent({ decisionsEnabled: false, ...DECISIONS, memoryRepeatCheckEnabled: true }))).toEqual([]);

  const nothing = buildSettingsConfigPayload(false, { config: load(BASE) }).agent;
  expect([nothing.memoryRepeatCheckEnabled, nothing.modelOverrides.memoryRepeatCheck, nothing.memoryRepeatCheckModel.model, nothing.memoryRepeatCheckModelFallbacks])
    .toEqual([false, false, "", []]);
  const set = withAgent({ decisionsEnabled: true, ...DECISIONS, ...REPEAT_OWN, memoryRepeatCheckModelFallbacks: [step("gw/deepseek/deepseek-flash")], memoryRepeatCheckEnabled: true });
  const agent = buildSettingsConfigPayload(false, { config: load(set) }).agent;
  expect([agent.memoryRepeatCheckEnabled, agent.modelOverrides.memoryRepeatCheck, agent.memoryRepeatCheckModel.model, agent.memoryRepeatCheckModelFallbacks.map((s) => s.model)])
    .toEqual([true, true, "gw/openai/gpt-6-luna", ["gw/deepseek/deepseek-flash"]]);
  const unset = withAgent({ memoryRepeatCheckModel: null, memoryRepeatCheckModelFallbacks: null, memoryRepeatCheckEnabled: null }, set);
  const back = buildSettingsConfigPayload(false, { config: load(unset) }).agent;
  expect([back.modelOverrides.memoryRepeatCheck, back.memoryRepeatCheckEnabled]).toEqual([false, false]);
  expect(() => withAgent({ memoryRepeatCheckEnabled: "yes" })).toThrow(/memoryRepeatCheckEnabled must be a boolean/);
  // A hand edit can leave anything there: only an explicit true turns it on.
  const raw = { ...withAgent({ decisionsEnabled: true, ...DECISIONS }) } as Raw;
  expect(memoryRepeatCheckChain(load({ ...raw, agent: { ...(raw.agent as Raw), memoryRepeatCheckEnabled: "maybe" } }))).toEqual([]);
});
