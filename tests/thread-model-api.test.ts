import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../src/server/config/load-config.js";
import type { Config } from "../src/server/config/types.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { mountAgentsRoutes } from "../src/server/modules/agent/agents-api.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { createAgentRuntimeProviders } from "../src/server/runtime/agent-providers.js";
import { createAgentRuntimeLlmRecorders } from "../src/server/runtime/agent-llm-recorders.js";
import { createAgentModelRouter, threadRouteSources } from "../src/server/runtime/agent-model-router.js";
import { createThreadModels } from "../src/server/runtime/thread-models.js";
import type { ScopeRuntime } from "../src/server/runtime/scope.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { onCleanup } from "./helpers/cleanup.js";
import { stub } from "./helpers/typed.js";
import { tempDir } from "./helpers/temp.js";

// A thread's model as its composer shows and sets it: Default (its route's),
// or a chat model Settings lists, stored on the thread.

function configWith(): Config {
  const dir = tempDir("md-thread-model-api-config-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: {
      default: { model: "main/gpt-5.5", modelFallbacks: [] },
      providers: {
        main: { type: "openai", apiKey: "main-key", models: [{ id: "gpt-5.5", input: ["text"] }, { id: "gpt-5.5-mini", input: ["text"] }] },
        backup: {
          type: "openai-compatible", apiKey: "backup-key", baseURL: "https://backup.example/v1",
          models: [{ id: "vision-1", input: ["text", "image"] }, { id: "judge-1", input: ["text"], kind: "decision" }]
        }
      }
    },
    agent: {
      managerModel: { model: "main/gpt-5.5", reasoningEffort: "high" },
      managerModelFallbacks: [{ model: "backup/vision-1", reasoningEffort: "low" }],
      logRequests: "metadata"
    }
  }));
  return loadConfig(dir);
}

function setup() {
  const env: StoresEnv = freshStoresEnv("md-thread-model-api-");
  onCleanup(() => env.cleanup());
  const config = configWith();
  const providers = createAgentRuntimeProviders(config);
  const recorders = createAgentRuntimeLlmRecorders({ config, store: env.store });
  const router = createAgentModelRouter({
    config: () => config,
    providers: () => providers,
    recorders: () => recorders,
    store: env.store,
    ...threadRouteSources({ agentStore: env.agentStore, backgroundTasks: new BackgroundTaskStore(env.store.db) })
  });
  const events: Array<{ event: string; data: unknown }> = [];
  const models = createThreadModels({ config: () => config, agentStore: env.agentStore, router, sse: { emit: (event, data) => events.push({ event, data }) } });
  return { env, router, models, events };
}

const ref = (providerName: string, model: string) => ({ ref: `${providerName}/${model}`, providerName, model });

test("a thread starts on Default: its route's model, with the chat models Settings lists by provider", () => {
  const s = setup();
  const thread = s.env.agentStore.createManagerThread("Release");
  expect(s.models.state(thread.id)).toEqual({
    default: ref("main", "gpt-5.5"),
    override: null,
    choices: [
      { providerName: "main", models: [ref("main", "gpt-5.5"), ref("main", "gpt-5.5-mini")] },
      { providerName: "backup", models: [ref("backup", "vision-1")] }
    ]
  });
  expect(s.models.state("thr_gone")).toBeNull();
});

test("a pick is stored on the thread, leads its calls, outlives the store, and Default clears it", () => {
  const s = setup();
  const thread = s.env.agentStore.createManagerThread("Release");
  expect(s.models.set(thread.id, "main/gpt-5.5-mini")).toEqual({ ok: true, state: expect.objectContaining({ override: ref("main", "gpt-5.5-mini") }) });
  expect(s.router.llmForThread(thread.id).candidates.map((c) => c.meta.model)).toEqual(["gpt-5.5-mini", "gpt-5.5", "vision-1"]);
  expect(new AgentStore(s.env.store.db).threadModelOverride(thread.id)).toBe("main/gpt-5.5-mini");
  expect(s.models.set(thread.id, null)).toEqual({ ok: true, state: expect.objectContaining({ override: null }) });
  expect(s.env.agentStore.threadModelOverride(thread.id)).toBeNull();
  expect(s.router.llmForThread(thread.id).candidates.map((c) => c.meta.model)).toEqual(["gpt-5.5", "vision-1"]);
});

test("a model Settings does not list for chat, a subagent's thread and a thread that is gone are refused, and nothing is stored", () => {
  const s = setup();
  const thread = s.env.agentStore.createManagerThread("Release");
  expect(s.models.set(thread.id, "backup/judge-1")).toEqual({ ok: false, status: 400, error: "Not a chat model in Settings: backup/judge-1" });
  expect(s.models.set(thread.id, "elsewhere/model-x")).toEqual({ ok: false, status: 400, error: "Not a chat model in Settings: elsewhere/model-x" });
  const child = s.env.agentStore.createSubagentThread("task_1");
  expect(s.models.set(child.id, "main/gpt-5.5-mini")).toEqual({ ok: false, status: 400, error: "A subagent runs on the model of the agent that started it." });
  expect(s.models.set("thr_gone", null)).toEqual({ ok: false, status: 404, error: "thread not found" });
  expect([s.env.agentStore.threadModelOverride(thread.id), s.env.agentStore.threadModelOverride(child.id)]).toEqual([null, null]);
  expect(s.events).toStrictEqual([]);
});

test("each change is announced with its thread", () => {
  const s = setup();
  const thread = s.env.agentStore.createManagerThread("Release");
  s.models.set(thread.id, "backup/vision-1");
  s.models.set(thread.id, null);
  expect(s.events).toStrictEqual([
    { event: "agentThreadModelChanged", data: { threadId: thread.id } },
    { event: "agentThreadModelChanged", data: { threadId: thread.id } }
  ]);
});

test("the thread's model route: read it, set it, Default it; a body that is not a model is refused; none without the service", async () => {
  const s = setup();
  const thread = s.env.agentStore.createManagerThread("Release");
  const mount = (withModels: boolean) => {
    const hono = new Hono();
    mountAgentsRoutes(hono, {
      agentStore: s.env.agentStore,
      wakeScheduler: { wake: () => "wake-1" },
      userMessageQueue: new AgentUserMessageQueue({ agentStore: s.env.agentStore, wakeScheduler: { wake: () => "wake-1" } }),
      scopes: {
        manager: stub<ScopeRuntime>({ verifyScopeId: () => null }),
        worker: stub<ScopeRuntime>({ verifyScopeId: () => null }),
        global: stub<ScopeRuntime>({ verifyScopeId: () => null }),
        subagent: stub<ScopeRuntime>({ verifyScopeId: () => null })
      },
      ...(withModels ? { threadModels: s.models } : {})
    });
    return hono;
  };
  const hono = mount(true);
  const url = `/api/agents/threads/${thread.id}/model`;
  const put = (body: string) => hono.request(url, { method: "PUT", headers: { "content-type": "application/json" }, body });
  const read = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });
  expect(await read(await hono.request(url))).toEqual({ status: 200, body: { model: s.models.state(thread.id) } });
  expect(await read(await put(JSON.stringify({ model: "main/gpt-5.5-mini" })))).toEqual({ status: 200, body: { model: expect.objectContaining({ override: ref("main", "gpt-5.5-mini") }) } });
  expect(await read(await put(JSON.stringify({ model: null })))).toEqual({ status: 200, body: { model: expect.objectContaining({ override: null }) } });
  expect((await put(JSON.stringify({ model: 7 }))).status).toBe(400);
  expect((await put(JSON.stringify({}))).status).toBe(400);
  expect((await put("{not json")).status).toBe(400);
  expect((await put(JSON.stringify({ model: "backup/judge-1" }))).status).toBe(400);
  expect((await hono.request(`/api/agents/threads/thr_gone/model`)).status).toBe(404);
  expect((await mount(false).request(url)).status).toBe(404);
});

test("an image for a thread is checked against the model the thread runs on first, the scope's only when there is none", async () => {
  const s = setup();
  const picked = s.env.agentStore.createManagerThread("Release");
  const plain = s.env.agentStore.createManagerThread("Docs");
  const hono = new Hono();
  mountAgentsRoutes(hono, {
    agentStore: s.env.agentStore,
    wakeScheduler: { wake: () => "wake-1" },
    userMessageQueue: new AgentUserMessageQueue({ agentStore: s.env.agentStore, wakeScheduler: { wake: () => "wake-1" } }),
    scopes: {
      manager: stub<ScopeRuntime>({ verifyScopeId: () => null }),
      worker: stub<ScopeRuntime>({ verifyScopeId: () => null }),
      global: stub<ScopeRuntime>({ verifyScopeId: () => null }),
      subagent: stub<ScopeRuntime>({ verifyScopeId: () => null })
    },
    // The route takes no images; one thread was switched to a model that does.
    modelSupportsInput: () => false,
    supportsInputForThread: (threadId) => threadId === picked.id
  });
  const image = { type: "image", id: "img-1", name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=" };
  const post = (threadId: string) => hono.request(`/api/agents/threads/${threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Look", attachments: [image] })
  });
  expect((await post(picked.id)).status).toBe(202);
  const refused = await post(plain.id);
  expect([refused.status, await refused.json()]).toEqual([400, { error: "current agent model does not support image input" }]);
});

test("a pick is stored as Settings names it, so a padded one is the same model; a provider name an object inherits is refused, not an error", async () => {
  const s = setup();
  const thread = s.env.agentStore.createManagerThread("Release");
  expect(s.models.set(thread.id, " main/gpt-5.5 ")).toEqual({ ok: true, state: expect.objectContaining({ override: ref("main", "gpt-5.5") }) });
  expect(s.env.agentStore.threadModelOverride(thread.id)).toBe("main/gpt-5.5");
  expect(s.router.llmForThread(thread.id).candidates.map((c) => c.meta.model)).toEqual(["gpt-5.5", "vision-1"]);
  for (const name of ["constructor/not-listed", "__proto__/not-listed", "toString/x"]) {
    expect(s.models.set(thread.id, name)).toEqual({ ok: false, status: 400, error: `Not a chat model in Settings: ${name}` });
  }
});
