import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/server/config/load-config.js";
import type { Config } from "../src/server/config/types.js";
import { MandateStore } from "../src/server/app/store.js";
import type { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import type { AgentScope } from "../src/server/modules/agent/agent-store.js";
import { createAgentRuntimeProviders } from "../src/server/runtime/agent-providers.js";
import { createAgentRuntimeLlmRecorders } from "../src/server/runtime/agent-llm-recorders.js";
import { createAgentModelRouter } from "../src/server/runtime/agent-model-router.js";
import { tempDir } from "./helpers/temp.js";

// A thread's own model, picked in its composer: it goes first, then the
// route's primary, then the route's fallbacks, each model once. Activity
// files each call under the model that made it.

const PROVIDERS = {
  main: {
    type: "openai", apiKey: "main-key",
    models: [{ id: "gpt-5.5", input: ["text"] }, { id: "gpt-5.5-mini", input: ["text"] }]
  },
  // A decision model lives on a compatible provider.
  backup: {
    type: "openai-compatible", apiKey: "backup-key", baseURL: "https://backup.example/v1",
    models: [{ id: "vision-1", input: ["text", "image"] }, { id: "judge-1", input: ["text"], kind: "decision" }]
  }
};

function configWith(agentExtra: Record<string, unknown> = {}, providers: Record<string, unknown> = PROVIDERS): Config {
  const dir = tempDir("md-thread-model-config-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: { default: { model: "main/gpt-5.5", modelFallbacks: [] }, providers },
    agent: {
      managerModel: { model: "main/gpt-5.5", reasoningEffort: "high" },
      managerModelFallbacks: [{ model: "backup/vision-1", reasoningEffort: "low" }],
      logRequests: "metadata",
      ...agentExtra
    }
  }));
  return loadConfig(dir);
}

const SCOPES = new Map<string, AgentScope>([
  ["thr_manager", "manager"], ["thr_other", "manager"], ["thr_sub", "subagent"], ["thr_sub_own", "subagent"]
]);
const PARENTS = new Map<string, string>([["thr_sub", "thr_manager"], ["thr_sub_own", "thr_manager"]]);

function setup(agentExtra: Record<string, unknown> = {}) {
  let config = configWith(agentExtra);
  const store = new MandateStore(tempDir("md-thread-model-store-"));
  let providers = createAgentRuntimeProviders(config);
  let recorders = createAgentRuntimeLlmRecorders({ config, store });
  const picks = new Map<string, string>();
  const router = createAgentModelRouter({
    config: () => config,
    providers: () => providers,
    recorders: () => recorders,
    store,
    scopeOf: (threadId) => SCOPES.get(threadId),
    parentOf: (threadId) => PARENTS.get(threadId),
    modelOverrideOf: (threadId) => picks.get(threadId) ?? null
  });
  const reload = (next: Config) => {
    config = next;
    providers = createAgentRuntimeProviders(config);
    recorders = createAgentRuntimeLlmRecorders({ config, store });
  };
  return { store, router, picks, reload };
}

const chainOf = (s: ReturnType<typeof setup>, threadId: string) =>
  s.router.llmForThread(threadId).candidates.map((c) => `${c.meta.providerName}/${c.meta.model}`);

function logged(store: MandateStore, recorder: AgentLlmCallRecorder | undefined) {
  if (!recorder) throw new Error("no recorder");
  const id = recorder.startCall({ purpose: "probe", scopeType: "agent_thread", scopeId: "thr" });
  return (store.db.prepare("select model from llm_calls where id = ?").get(id) as { model: string }).model;
}

test("a thread's pick goes first, then the route's primary, then its fallbacks, each model once", () => {
  const s = setup();
  expect(chainOf(s, "thr_manager")).toEqual(["main/gpt-5.5", "backup/vision-1"]);
  s.picks.set("thr_manager", "main/gpt-5.5-mini");
  expect(chainOf(s, "thr_manager")).toEqual(["main/gpt-5.5-mini", "main/gpt-5.5", "backup/vision-1"]);
  s.picks.set("thr_manager", "backup/vision-1");
  expect(chainOf(s, "thr_manager")).toEqual(["backup/vision-1", "main/gpt-5.5"]);
  s.picks.set("thr_manager", "main/gpt-5.5");
  expect(chainOf(s, "thr_manager")).toEqual(["main/gpt-5.5", "backup/vision-1"]);
  // Another thread of the same kind keeps the route.
  expect(chainOf(s, "thr_other")).toEqual(["main/gpt-5.5", "backup/vision-1"]);
});

test("the pick runs at the route's reasoning effort, and leads the call", () => {
  const s = setup();
  s.picks.set("thr_manager", "main/gpt-5.5-mini");
  const llm = s.router.llmForThread("thr_manager");
  expect(llm.candidates[0]!.meta.reasoningEffort).toBe("high");
  expect(llm.model).toBe(llm.candidates[0]!.model);
});

test("Activity files the pick's calls under the pick, and the route's primary under its own", () => {
  const s = setup();
  s.picks.set("thr_manager", "main/gpt-5.5-mini");
  const llm = s.router.llmForThread("thr_manager");
  expect(logged(s.store, llm.llmCallRecorder)).toBe("gpt-5.5-mini");
  expect(logged(s.store, llm.candidates[0]!.llmCallRecorder)).toBe("gpt-5.5-mini");
  expect(logged(s.store, llm.candidates[1]!.llmCallRecorder)).toBe("gpt-5.5");
  expect(logged(s.store, llm.candidates[2]!.llmCallRecorder)).toBe("vision-1");
});

test("a pick Settings no longer has, or a decision model, is passed over", () => {
  const s = setup();
  s.picks.set("thr_manager", "gone/model-x");
  expect(chainOf(s, "thr_manager")).toEqual(["main/gpt-5.5", "backup/vision-1"]);
  s.picks.set("thr_manager", "backup/judge-1");
  expect(chainOf(s, "thr_manager")).toEqual(["main/gpt-5.5", "backup/vision-1"]);
  s.picks.set("thr_manager", "main/gpt-5.5-mini");
  s.reload(configWith({}, { ...PROVIDERS, main: { ...PROVIDERS.main, models: [PROVIDERS.main.models[0]!] } }));
  expect(chainOf(s, "thr_manager")).toEqual(["main/gpt-5.5", "backup/vision-1"]);
});

test("a subagent on its parent's route follows the parent's pick; one on a route of its own does not", () => {
  const s = setup();
  s.picks.set("thr_manager", "main/gpt-5.5-mini");
  expect(chainOf(s, "thr_sub")[0]).toBe("main/gpt-5.5-mini");
  const own = setup({ subagentModel: { model: "main/gpt-5.5", reasoningEffort: "low" }, subagentModelFallbacks: [] });
  own.picks.set("thr_manager", "main/gpt-5.5-mini");
  expect(chainOf(own, "thr_sub_own")).toEqual(["main/gpt-5.5"]);
});

test("what the thread takes in, and its compaction, follow the pick", () => {
  const s = setup({ managerModel: { model: "main/gpt-5.5", reasoningEffort: "high" }, managerModelFallbacks: [] });
  expect(s.router.supportsInputForThread("thr_manager", "image")).toBe(false);
  s.picks.set("thr_manager", "backup/vision-1");
  expect(s.router.supportsInputForThread("thr_manager", "image")).toBe(true);
  const compression = s.router.compressionForThread("thr_manager");
  expect(compression.candidates.map((c) => c.provider)).toEqual(["openai-compatible", "openai"]);
  expect(logged(s.store, compression.candidates[0]!.recorder)).toBe("vision-1");
});

test("a pick stored with spaces around its parts is still the one model", () => {
  const s = setup();
  s.picks.set("thr_manager", " main / gpt-5.5 ");
  expect(chainOf(s, "thr_manager")).toEqual(["main/gpt-5.5", "backup/vision-1"]);
});
