import { expect, test } from "bun:test";
import { Hono } from "hono";
import { CanvasStore } from "../../src/server/modules/canvas/canvas-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { ThreadDeletion } from "../../src/server/modules/agent/thread-delete.js";
import { buildAgentsTestApp, buildTestScopes, deleteJson, getJson } from "../helpers/test-app.js";
import { freshAgentEnv, NOOP_WAKE } from "../helpers/fixtures.js";
import { stub } from "../helpers/typed.js";
import { mountAgentModuleRoutes } from "../../src/server/modules/agent/agent-routes.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import type { AppDeps } from "../../src/server/app/deps.js";
import type { Config } from "../../src/server/config.js";
import type { AgentSseEmitter } from "../../src/server/modules/sse/sse-events.js";

// The archived threads over HTTP: listed, deleted one at a time, or all at once.

function setup(prefix: string) {
  const env = freshAgentEnv(prefix);
  const threadDeletion = new ThreadDeletion({ db: env.store.db, agentStore: env.agentStore, canvases: new CanvasStore(env.store.db, env.dir) });
  const app = buildAgentsTestApp({
    agentStore: env.agentStore,
    wakeScheduler: NOOP_WAKE,
    scopes: buildTestScopes(new FeaturesStore(env.store.db)),
    threadDeletion
  });
  const thread = (title: string, archived: boolean) => {
    const id = env.agentStore.createManagerThread(title).id;
    if (archived) env.agentStore.archiveThread(id);
    return id;
  };
  return { env, app, thread };
}

test("the archived threads are listed apart from the open ones", async () => {
  const { env, app, thread } = setup("md-del-routes-list-");
  try {
    const archived = thread("project-1 cache expiry", true);
    thread("project-1 release notes", false);
    const r = await getJson(app, "/api/agents/manager/threads?archived=1");
    expect(r.status).toBe(200);
    expect(r.body.archived.map((t: { id: string; title: string; workers: number; canvases: number }) => [t.id, t.title, t.workers, t.canvases])).toEqual([[archived, "project-1 cache expiry", 0, 0]]);
  } finally { env.cleanup(); }
});

test("one archived thread is deleted; an open one is refused, a missing one not found", async () => {
  const { env, app, thread } = setup("md-del-routes-one-");
  try {
    const archived = thread("project-1 cache expiry", true);
    const open = thread("project-1 release notes", false);
    expect(await deleteJson(app, `/api/agents/manager/threads/${archived}`)).toEqual({ status: 200, body: { ok: true, deleted: { threads: 1, workers: 0, canvases: 0 } } });
    expect(env.agentStore.getThreadById(archived)).toBeNull();
    expect(await deleteJson(app, `/api/agents/manager/threads/${open}`)).toEqual({ status: 409, body: { error: "Archive the thread first." } });
    expect(await deleteJson(app, "/api/agents/manager/threads/thr_missing")).toEqual({ status: 404, body: { error: "thread not found" } });
    expect(env.agentStore.getThreadById(open)).not.toBeNull();
  } finally { env.cleanup(); }
});

test("every archived thread is deleted at once only when the request says archived; open ones stay", async () => {
  const { env, app, thread } = setup("md-del-routes-all-");
  try {
    const a = thread("project-1 cache expiry", true);
    const b = thread("project-2 flaky upload", true);
    const open = thread("project-1 release notes", false);
    expect((await deleteJson(app, "/api/agents/manager/threads")).status).toBe(400);
    expect(env.agentStore.getThreadById(a)).not.toBeNull();
    expect(await deleteJson(app, "/api/agents/manager/threads?archived=1")).toEqual({ status: 200, body: { ok: true, count: 2, skipped: 0 } });
    expect([a, b].map((id) => env.agentStore.getThreadById(id))).toEqual([null, null]);
    expect(env.agentStore.getThreadById(open)).not.toBeNull();
  } finally { env.cleanup(); }
});

test("the app's delete waits for what the runtime says still works on the thread", async () => {
  const env = freshAgentEnv("md-del-routes-working-");
  const features = new FeaturesStore(env.store.db);
  const working = new Set<string>();
  const app = new Hono();
  mountAgentModuleRoutes(app, stub<AppDeps>({
    store: env.store, agentStore: env.agentStore, canvasStore: new CanvasStore(env.store.db, env.dir),
    workStore: new WorkItemStore(env.store.db), features, wakeScheduler: NOOP_WAKE,
    scopes: buildTestScopes(features), sse: stub<AgentSseEmitter>({ emit: () => {} }),
    config: stub<Config>({ agent: stub<Config["agent"]>({ compressionThresholdTokens: 100_000 }) }),
    isThreadWorking: (threadId) => working.has(threadId)
  }));
  const id = env.agentStore.createManagerThread("project-1 cache expiry").id;
  env.agentStore.archiveThread(id);
  working.add(id);
  expect(await deleteJson(app, `/api/agents/manager/threads/${id}`)).toEqual({ status: 409, body: { error: "Its work is still stopping. Try again in a moment." } });
  working.delete(id);
  expect((await deleteJson(app, `/api/agents/manager/threads/${id}`)).status).toBe(200);
  expect(env.agentStore.getThreadById(id)).toBeNull();
});
