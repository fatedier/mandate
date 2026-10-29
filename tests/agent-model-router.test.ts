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
import { compressionApiMode } from "../src/server/runtime/agent-compression-llm.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { createAgentModelRouter, threadRouteSources } from "../src/server/runtime/agent-model-router.js";
import { newId } from "../src/server/platform/ids.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { tempDir } from "./helpers/temp.js";

// Which model and which Activity recorder each kind of call uses, per thread.
// It lived in agent-runtime's closure with no test of its own.

function configWith(managerModel: string, globalModel?: string, agentExtra: Record<string, unknown> = {}): Config {
  const dir = tempDir("md-router-config-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: {
      default: { model: "main/gpt-5.5", modelFallbacks: ["backup/vision-1"] },
      providers: {
        main: { type: "openai", apiKey: "main-key", models: [{ id: "gpt-5.5", input: ["text"] }, { id: "gpt-5.5-mini", input: ["text"] }] },
        backup: { type: "openai-compatible", apiKey: "backup-key", baseURL: "https://backup.example/v1", models: [{ id: "vision-1", input: ["text", "image"] }] }
      }
    },
    agent: { managerModel, managerModelFallbacks: [], ...(globalModel ? { globalModel, globalModelFallbacks: [] } : {}), ...agentExtra, logRequests: "metadata" }
  }));
  return loadConfig(dir);
}

/** Threads by scope, and each subagent's parent as its background task names
 *  it: a child of each kind of agent, one whose task is gone, and one whose
 *  parent thread is. */
const SCOPES = new Map<string, AgentScope>([
  ["thr_manager", "manager"], ["thr_worker", "worker"], ["thr_global", "global"],
  ["thr_sub_manager", "subagent"], ["thr_sub_worker", "subagent"], ["thr_sub_global", "subagent"],
  ["thr_sub_no_task", "subagent"], ["thr_sub_parent_gone", "subagent"], ["thr_sub_page", "subagent"]
]);
const PARENTS = new Map<string, string>([
  ["thr_sub_manager", "thr_manager"], ["thr_sub_worker", "thr_worker"], ["thr_sub_global", "thr_global"],
  ["thr_sub_parent_gone", "thr_deleted"], ["thr_sub_page", "thr_global"]
]);

function setup(managerModel = "backup/vision-1", globalModel?: string, agentExtra: Record<string, unknown> = {}) {
  let config = configWith(managerModel, globalModel, agentExtra);
  const store = new MandateStore(tempDir("md-router-store-"));
  let providers = createAgentRuntimeProviders(config);
  let recorders = createAgentRuntimeLlmRecorders({ config, store });
  const router = createAgentModelRouter({
    config: () => config,
    providers: () => providers,
    recorders: () => recorders,
    store,
    scopeOf: (threadId) => SCOPES.get(threadId),
    parentOf: (threadId) => PARENTS.get(threadId),
    isPageSubagent: (threadId) => threadId === "thr_sub_page"
  });
  const reload = (next: Config) => {
    config = next;
    providers = createAgentRuntimeProviders(config);
    recorders = createAgentRuntimeLlmRecorders({ config, store });
  };
  return { store, router, providers: () => providers, recorders: () => recorders, reload };
}

const chainOf = (s: ReturnType<typeof setup>, threadId: string) =>
  s.router.llmForThread(threadId).candidates.map((candidate) => candidate.meta.model);

/** What a recorder writes for a call: Activity's row. */
function logged(store: MandateStore, recorder: AgentLlmCallRecorder) {
  const id = recorder.startCall({ purpose: "probe", scopeType: "agent_thread", scopeId: "thr" });
  return store.db.prepare("select provider, model, api_mode from llm_calls where id = ?").get(id) as { provider: string; model: string; api_mode: string };
}

test("a manager thread's wake uses the manager's model and recorder; a worker thread's, the worker's", () => {
  const s = setup();
  const manager = s.router.llmForThread("thr_manager");
  expect(manager.model).toBe(s.providers().managerProvider.model);
  expect(manager.llmCallRecorder).toBe(s.recorders().managerWakeRecorder);
  const worker = s.router.llmForThread("thr_worker");
  expect(worker.model).toBe(s.providers().workerProvider.model);
  expect(worker.llmCallRecorder).toBe(s.recorders().workerWakeRecorder);
});

test("a wake's fallback model gets a recorder of its own, logged under its provider and model", () => {
  const s = setup();
  const candidates = s.router.llmForThread("thr_worker").candidates;
  expect(candidates.length).toBe(2);
  expect(candidates[0]!.llmCallRecorder).toBe(s.recorders().workerWakeRecorder);
  expect(logged(s.store, candidates[1]!.llmCallRecorder!)).toEqual({ provider: "openai-compatible", model: "vision-1", api_mode: "streamText" });
  // Image input is read per candidate model.
  expect(candidates.map((c) => c.supportsImageInput)).toEqual([false, true]);
});

test("compression uses its scope's model and its own recorders", () => {
  const s = setup();
  const managerCompression = s.router.compressionForThread("thr_manager");
  expect(managerCompression.model).toBe(s.providers().managerProvider.model);
  expect(managerCompression.recorder).toBe(s.recorders().compressionManagerRecorder);
  const workerCompression = s.router.compressionForThread("thr_worker");
  expect(workerCompression.recorder).toBe(s.recorders().compressionWorkerRecorder);
  expect(workerCompression.candidates![0]!.recorder).toBe(s.recorders().compressionWorkerRecorder);
  expect(logged(s.store, workerCompression.candidates![1]!.recorder!))
    .toEqual({ provider: "openai-compatible", model: "vision-1", api_mode: compressionApiMode("openai-compatible") });
});

test("input support follows the scope's model: text always, an image only where the model takes one", () => {
  const s = setup();
  expect(s.router.supportsInputForScope("worker", "text")).toBe(true);
  expect(s.router.supportsInputForScope("worker", "image")).toBe(false);
  expect(s.router.supportsInputForScope("manager", "image")).toBe(true);
  expect(s.router.supportsInputForThread("thr_manager", "image")).toBe(true);
  // A thread the router does not know reads as a worker.
  expect(s.router.supportsInputForThread("thr_gone", "image")).toBe(false);
});

test("after a config reload the next call routes to the new models", () => {
  const s = setup();
  s.reload(configWith("main/gpt-5.5-mini"));
  const manager = s.router.llmForThread("thr_manager");
  expect(manager.model).toBe(s.providers().managerProvider.model);
  expect(manager.llmCallRecorder).toBe(s.recorders().managerWakeRecorder);
  expect(s.router.supportsInputForScope("manager", "image")).toBe(false);
});

test("Your agent's thread runs on its own route: its model and recorders for turns and compaction, and its own input checks", () => {
  const s = setup("backup/vision-1", "main/gpt-5.5-mini");
  const wake = s.router.llmForThread("thr_global");
  expect(wake.model).toBe(s.providers().globalProvider.model);
  expect(wake.candidates[0]!.meta.model).toBe("gpt-5.5-mini");
  expect(wake.llmCallRecorder).toBe(s.recorders().globalWakeRecorder);
  expect(s.router.compressionForThread("thr_global").recorder).toBe(s.recorders().compressionGlobalRecorder);
  expect(logged(s.store, s.recorders().globalWakeRecorder)).toEqual({ provider: "openai", model: "gpt-5.5-mini", api_mode: "streamText" });
  // Its model takes no image; the manager's does.
  expect(s.router.supportsInputForScope("global", "image")).toBe(false);
  expect(s.router.supportsInputForThread("thr_global", "image")).toBe(false);
  expect(s.router.supportsInputForScope("manager", "image")).toBe(true);
  // A manager thread keeps the manager's.
  expect(s.router.llmForThread("thr_manager").candidates[0]!.meta.model).toBe("vision-1");
});

test("without a route of its own, Your agent's thread runs on the default's, not the manager's", () => {
  const s = setup("backup/vision-1");
  const wake = s.router.llmForThread("thr_global");
  expect(wake.candidates.map((c) => c.meta.model)).toEqual(["gpt-5.5", "vision-1"]);
  expect(s.router.supportsInputForScope("global", "image")).toBe(false);
  expect(s.router.llmForThread("thr_manager").candidates[0]!.meta.model).toBe("vision-1");
});

test("memory extraction runs on its own route whatever the thread: its first model on its recorder, then its fallbacks", () => {
  const s = setup("backup/vision-1", "main/gpt-5.5", { extractionModel: "main/gpt-5.5-mini", extractionModelFallbacks: ["backup/vision-1"] });
  const llm = s.router.memoryExtraction();
  expect(llm.candidates.map((candidate) => [candidate.provider, candidate.recorder === s.recorders().memoryExtractionRecorder]))
    .toEqual([["openai", true], ["openai-compatible", false]]);
  expect(logged(s.store, s.recorders().memoryExtractionRecorder))
    .toEqual({ provider: "openai", model: "gpt-5.5-mini", api_mode: compressionApiMode("openai") });
  expect(logged(s.store, llm.candidates[1]!.recorder!))
    .toEqual({ provider: "openai-compatible", model: "vision-1", api_mode: compressionApiMode("openai-compatible") });
  // Without a route of its own: the default's, not the thread's or the manager's.
  const d = setup("backup/vision-1", "main/gpt-5.5-mini");
  expect(logged(d.store, d.recorders().memoryExtractionRecorder))
    .toEqual({ provider: "openai", model: "gpt-5.5", api_mode: compressionApiMode("openai") });
  expect(d.router.memoryExtraction().candidates.length).toBe(2);
});

test("a subagent runs on the route of the agent that started it: its models, recorders and input checks", () => {
  const s = setup("backup/vision-1", "main/gpt-5.5-mini");
  expect(chainOf(s, "thr_sub_manager")).toEqual(["vision-1"]);
  expect(chainOf(s, "thr_sub_worker")).toEqual(["gpt-5.5", "vision-1"]);
  expect(chainOf(s, "thr_sub_global")).toEqual(["gpt-5.5-mini"]);
  expect(s.router.llmForThread("thr_sub_manager").llmCallRecorder).toBe(s.recorders().managerWakeRecorder);
  expect(s.router.llmForThread("thr_sub_worker").llmCallRecorder).toBe(s.recorders().workerWakeRecorder);
  expect(s.router.llmForThread("thr_sub_global").llmCallRecorder).toBe(s.recorders().globalWakeRecorder);
  expect(s.router.compressionForThread("thr_sub_manager").recorder).toBe(s.recorders().compressionManagerRecorder);
  expect(s.router.compressionForThread("thr_sub_global").recorder).toBe(s.recorders().compressionGlobalRecorder);
  // Images follow the model that runs: the manager's takes them, the worker's does not.
  expect(s.router.supportsInputForThread("thr_sub_manager", "image")).toBe(true);
  expect(s.router.supportsInputForThread("thr_sub_worker", "image")).toBe(false);
});

test("a subagent whose task or parent thread is gone runs as a worker, and by scope alone a subagent answers as one", () => {
  const s = setup("backup/vision-1", "main/gpt-5.5-mini");
  for (const threadId of ["thr_sub_no_task", "thr_sub_parent_gone"]) {
    expect(s.router.llmForThread(threadId).llmCallRecorder).toBe(s.recorders().workerWakeRecorder);
    expect(chainOf(s, threadId)).toEqual(["gpt-5.5", "vision-1"]);
  }
  // The manager's model takes images; a worker's does not.
  expect(s.router.supportsInputForScope("subagent", "image")).toBe(false);
});

test("the router's thread lookups come from the stores: a subagent's scope, and its parent through its background task", () => {
  const env = freshStoresEnv("md-router-tasks-");
  const backgroundTasks = new BackgroundTaskStore(env.store.db);
  const manager = env.agentStore.createManagerThread();
  // As the subagent tool makes one: the child's thread for the task's id, then the task naming that thread.
  const taskId = newId("task");
  const child = env.agentStore.createSubagentThread(taskId);
  backgroundTasks.create({ id: taskId, parentThreadId: manager.id, childThreadId: child.id, type: "general", title: "Release notes", task: "Summarise the release notes." });
  const sources = threadRouteSources({ agentStore: env.agentStore, backgroundTasks });
  expect([sources.scopeOf(child.id), sources.parentOf(child.id)]).toEqual(["subagent", manager.id]);
  expect([sources.scopeOf(manager.id), sources.parentOf(manager.id)]).toEqual(["manager", undefined]);
  expect([sources.scopeOf("thr_gone"), sources.parentOf("thr_gone")]).toEqual([undefined, undefined]);
  // Through them the child runs on its manager's route.
  const config = configWith("backup/vision-1");
  const providers = createAgentRuntimeProviders(config);
  const recorders = createAgentRuntimeLlmRecorders({ config, store: env.store });
  const router = createAgentModelRouter({ config: () => config, providers: () => providers, recorders: () => recorders, store: env.store, ...sources });
  expect(router.llmForThread(child.id).candidates.map((c) => c.meta.model)).toEqual(["vision-1"]);
});

test("with a subagent route, every subagent runs on it whatever agent started it; the agents' own threads keep theirs", () => {
  const s = setup("backup/vision-1", undefined, {
    subagentModel: { model: "main/gpt-5.5-mini", reasoningEffort: "low" },
    subagentModelFallbacks: ["backup/vision-1"]
  });
  for (const threadId of ["thr_sub_manager", "thr_sub_worker", "thr_sub_global", "thr_sub_no_task"]) {
    const wake = s.router.llmForThread(threadId);
    expect(wake.candidates.map((c) => [c.meta.model, c.meta.reasoningEffort])).toEqual([["gpt-5.5-mini", "low"], ["vision-1", "provider-default"]]);
    expect(wake.llmCallRecorder).toBe(s.recorders().subagentWakeRecorder);
    expect(s.router.compressionForThread(threadId).recorder).toBe(s.recorders().compressionSubagentRecorder);
    // Its first model takes no image, though the manager's does.
    expect(s.router.supportsInputForThread(threadId, "image")).toBe(false);
  }
  expect(logged(s.store, s.recorders().subagentWakeRecorder)).toEqual({ provider: "openai", model: "gpt-5.5-mini", api_mode: "streamText" });
  expect(logged(s.store, s.recorders().compressionSubagentRecorder))
    .toEqual({ provider: "openai", model: "gpt-5.5-mini", api_mode: compressionApiMode("openai") });
  expect(logged(s.store, s.router.llmForThread("thr_sub_manager").candidates[1]!.llmCallRecorder!))
    .toEqual({ provider: "openai-compatible", model: "vision-1", api_mode: "streamText" });
  expect(chainOf(s, "thr_manager")).toEqual(["vision-1"]);
  expect(s.router.supportsInputForThread("thr_manager", "image")).toBe(true);
});

test("a subagent route saved as the default's own chain is still the subagent route, not the asking agent's", () => {
  const s = setup("backup/vision-1", undefined, { subagentModel: "main/gpt-5.5", subagentModelFallbacks: ["backup/vision-1"] });
  expect(chainOf(s, "thr_sub_manager")).toEqual(["gpt-5.5", "vision-1"]);
  expect(s.router.llmForThread("thr_sub_manager").llmCallRecorder).toBe(s.recorders().subagentWakeRecorder);
});

test("after a reload a running subagent's next call follows the subagent route as now saved", () => {
  const s = setup("backup/vision-1");
  expect(chainOf(s, "thr_sub_manager")).toEqual(["vision-1"]);
  s.reload(configWith("backup/vision-1", undefined, { subagentModel: "main/gpt-5.5-mini", subagentModelFallbacks: [] }));
  expect(chainOf(s, "thr_sub_manager")).toEqual(["gpt-5.5-mini"]);
  s.reload(configWith("backup/vision-1"));
  expect(chainOf(s, "thr_sub_manager")).toEqual(["vision-1"]);
});

test("a page subagent runs on the page route when one is set, else as subagents do", () => {
  // Nothing set: as Your agent's other subagents, on Your agent's route.
  const none = setup("backup/vision-1", "main/gpt-5.5-mini");
  expect(chainOf(none, "thr_sub_page")).toEqual(chainOf(none, "thr_sub_global"));
  expect(none.router.llmForThread("thr_sub_page").llmCallRecorder).toBe(none.recorders().globalWakeRecorder);
  // The subagent route alone: on it.
  const subagents = setup("backup/vision-1", "main/gpt-5.5-mini", { subagentModel: "backup/vision-1", subagentModelFallbacks: [] });
  expect(chainOf(subagents, "thr_sub_page")).toEqual(["vision-1"]);
  expect(subagents.router.llmForThread("thr_sub_page").llmCallRecorder).toBe(subagents.recorders().subagentWakeRecorder);
  // Its own route: on it, for turns and compaction, with its own input checks; the other subagents keep theirs.
  for (const extra of [{}, { subagentModel: "backup/vision-1", subagentModelFallbacks: [] }]) {
    const own = setup("backup/vision-1", "main/gpt-5.5-mini", { ...extra, pageModel: { model: "main/gpt-5.5", reasoningEffort: "high" }, pageModelFallbacks: [] });
    const wake = own.router.llmForThread("thr_sub_page");
    expect(wake.candidates.map((c) => [c.meta.model, c.meta.reasoningEffort])).toEqual([["gpt-5.5", "high"]]);
    expect(wake.llmCallRecorder).toBe(own.recorders().pageWakeRecorder);
    expect(own.router.compressionForThread("thr_sub_page").recorder).toBe(own.recorders().compressionPageRecorder);
    expect(own.router.supportsInputForThread("thr_sub_page", "image")).toBe(false);
    expect(chainOf(own, "thr_sub_global")).toEqual("subagentModel" in extra ? ["vision-1"] : ["gpt-5.5-mini"]);
  }
});

test("the router knows a page subagent by its background task's type", () => {
  const env = freshStoresEnv("md-router-page-");
  try {
    const tasks = new BackgroundTaskStore(env.store.db);
    const global = env.agentStore.getOrCreateGlobalThread();
    const ids = ["general", "page"].map((type) => {
      const id = newId("task");
      const child = env.agentStore.createSubagentThread(id);
      tasks.create({ id, parentThreadId: global.id, childThreadId: child.id, type: type as "general" | "page", title: type, task: type });
      return child.id;
    });
    const sources = threadRouteSources({ agentStore: env.agentStore, backgroundTasks: tasks });
    expect(ids.map((id) => sources.isPageSubagent!(id))).toEqual([false, true]);
    expect(sources.isPageSubagent!(global.id)).toBe(false);
  } finally { env.cleanup(); }
});

// Each use of Decisions asks the models of its own chain, each logged under
// its own provider and model.
test("manager request check and manager stop check each ask their own chain's models, with a recorder each", () => {
  const s = setup("backup/vision-1", undefined, {
    decisionsEnabled: true, decisionsModel: "main/gpt-5.5-mini", decisionsModelFallbacks: [],
    managerStopCheckEnabled: true, managerStopCheckModel: "backup/vision-1", managerStopCheckModelFallbacks: []
  });
  const models = (candidates: ReturnType<typeof s.router.managerStopCheck>) => candidates.map((c) => logged(s.store, c.recorder).model);
  expect([models(s.router.managerRequestCheck()), models(s.router.managerStopCheck())]).toEqual([["gpt-5.5-mini"], ["vision-1"]]);
});

// Memory repeat check rides with memory extraction's route: the models it
// asks before a memory is stored, none while it is off.
test("memory extraction's route carries memory repeat check's models once it is on", () => {
  const on = setup("backup/vision-1", undefined, {
    decisionsEnabled: true, decisionsModel: "main/gpt-5.5-mini", decisionsModelFallbacks: ["backup/vision-1"], memoryRepeatCheckEnabled: true
  });
  expect(on.router.memoryExtraction().repeatCheck.map((c) => logged(on.store, c.recorder).model)).toEqual(["gpt-5.5-mini", "vision-1"]);
  const off = setup("backup/vision-1", undefined, { decisionsEnabled: true, decisionsModel: "main/gpt-5.5-mini", decisionsModelFallbacks: [] });
  expect(off.router.memoryExtraction().repeatCheck).toEqual([]);
});
