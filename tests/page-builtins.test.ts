import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, seedFeature, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { readBuiltin, type PageBuiltinDeps } from "../src/server/modules/page/page-builtins.js";
import { mountPageRoutes } from "../src/server/modules/page/page-routes.js";
import { API_PATHS, API_ROUTES } from "../src/shared/api-contracts.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

/** A thread with a worker whose plan is done and one that asks, a canvas, a
 *  question Your agent asked, and a day of model calls. */
function seeded() {
  env = freshStoresEnv("md-page-builtins-");
  const workStore = new WorkItemStore(env.store.db);
  const planStore = new PlanStore(env.store.db);
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const thread = env.agentStore.createManagerThread("Docs overhaul");
  const projectId = seedProject(env.projects, { name: "mandate", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const release = seedFeature(env.features, projectId, { name: "release", ownerThreadId: thread.id });
  expect(planStore.update(release, { conclusion: "Tagged 3.21; the changelog is written.", steps: [{ title: "Tag", status: "done", note: "git tag v3.21 pushed" }] })).toMatchObject({ ok: true });
  const evict = seedFeature(env.features, projectId, { name: "evict", tmuxWindowName: "evict", ownerThreadId: thread.id });
  expect(planStore.update(evict, { steps: [{ title: "Wire the hook", status: "in_progress" }] })).toMatchObject({ ok: true });
  // A second thread, whose worker failed.
  const cacheThread = env.agentStore.createManagerThread("Cache work");
  const cache = seedFeature(env.features, projectId, { name: "cache", tmuxWindowName: "cache", ownerThreadId: cacheThread.id });
  workStore.setFailure(cache, { at: new Date().toISOString(), message: "The provider refused the request.", kind: "error" });
  const older = canvasStore.create({ title: "Old notes", scope: "manager", scopeId: null, threadId: thread.id, kind: "report" });
  env.store.db.prepare("update canvas_documents set updated_at = '2026-01-01T00:00:00.000Z' where id = ?").run(older.id);
  const canvas = canvasStore.create({ title: "Cache report", scope: "manager", scopeId: null, threadId: thread.id, kind: "report" });
  const global = env.agentStore.getOrCreateGlobalThread();
  env.agentStore.appendMessage({
    threadId: global.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: "q_ab12cd", question: "Tag 3.21 today?", options: [] } }
  });
  const call = env.store.startLlmCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: thread.id, provider: "openai", model: "gpt-5.5", requestJson: {} });
  env.store.finishLlmCall(call.id, { status: "succeeded", responseJson: {}, outputJson: {}, inputTokens: 1200, outputTokens: 30, totalTokens: 1230 });
  const deps: PageBuiltinDeps = {
    db: env.store.db,
    agentStore: env.agentStore,
    managerThreads: new ManagerThreadService({ agentStore: env.agentStore }),
    canvasStore,
    featuresStore: env.features,
    projectsStore: env.projects,
    workStore,
    planStore,
    isBusy: () => false,
    waitKind: () => null,
    statusSnapshot: () => ({
      threads: [{ threadId: thread.id, state: "decision" }, { threadId: cacheThread.id, state: "failed" }],
      waiting: [
        { key: "agent:agent:input", kind: "agent", waiting: "input", threadId: null, threadTitle: null, featureId: null, workerName: null, text: "Tag 3.21 today?", place: null },
        { key: `thread:${cacheThread.id}:failed`, kind: "thread", waiting: "failed", threadId: cacheThread.id, threadTitle: "Cache work", featureId: null, workerName: null, text: "The provider refused the request.", place: null },
        { key: `worker:${evict}:input`, kind: "worker", waiting: "input", threadId: thread.id, threadTitle: "Docs overhaul", featureId: evict, workerName: "evict", text: "Wire it now?", place: null },
        { key: `thread:${thread.id}:decision`, kind: "thread", waiting: "decision", threadId: thread.id, threadTitle: "Docs overhaul", featureId: null, workerName: null, text: "**Two options**: keep or drop.", place: null }
      ]
    })
  };
  return { deps, thread, release, evict, canvas, global, cacheThread, cache, older };
}

test("each built-in has the agent-page skill's field names, from what Mandate shows elsewhere", () => {
  const { deps, thread, release, evict, canvas, cacheThread, cache, older } = seeded();
  const threads = readBuiltin("threads", deps) as Array<Record<string, unknown>>;
  expect(threads.find((t) => t.id === thread.id)).toEqual(
    { id: thread.id, title: "Docs overhaul", state: "decision", lastActivityAt: expect.any(String), link: `/threads/${thread.id}` }
  );
  // The state the server worked out, the one the sidebar draws.
  expect(threads.find((t) => t.id === cacheThread.id)).toMatchObject({ state: "failed" });
  const workers = readBuiltin("workers", deps) as Array<Record<string, unknown>>;
  for (const worker of workers) expect(Object.keys(worker).sort()).toEqual(["id", "line", "link", "name", "state", "threadId"]);
  expect(workers.find((w) => w.id === cache)).toMatchObject({ state: "failed", line: "Failed: The provider refused the request." });
  expect(workers.find((w) => w.id === release)).toEqual({
    id: release, name: "release", threadId: thread.id, state: "done", line: "Tagged 3.21; the changelog is written.",
    link: `/threads/${thread.id}?worker=${release}`
  });
  expect(workers.find((w) => w.id === evict)).toMatchObject({ state: "in_progress", line: expect.stringContaining("Wire the hook") });
  // Home's list, its kind carried as data; Your agent's own question is its "questions" source.
  expect(readBuiltin("waiting", deps)).toEqual([
    { waiting: "failed", title: "Cache work", text: "The provider refused the request.", link: `/threads/${cacheThread.id}` },
    { waiting: "input", title: "Docs overhaul", text: "Wire it now?", link: `/threads/${thread.id}?worker=${evict}` },
    { waiting: "decision", title: "Docs overhaul", text: "**Two options**: keep or drop.", link: `/threads/${thread.id}` }
  ]);
  const usage = readBuiltin("usage", deps) as { days: Array<Record<string, unknown>> };
  expect(usage.days).toEqual([{ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), inputTokens: 1200, outputTokens: 30, cacheReadTokens: 0, calls: 1 }]);
  // Newest first.
  expect(readBuiltin("canvases", deps)).toEqual([
    { id: canvas.id, title: "Cache report", kind: "report", updatedAt: canvas.updatedAt, link: `/canvas/${canvas.id}` },
    { id: older.id, title: "Old notes", kind: "report", updatedAt: "2026-01-01T00:00:00.000Z", link: `/canvas/${older.id}` }
  ]);
  expect(readBuiltin("questions", deps)).toEqual([{ id: "q_ab12cd", question: "Tag 3.21 today?", askedAt: expect.any(String) }]);
  expect(readBuiltin("answers", deps)).toEqual([]);
});

test("a built-in or a listed source is read by its name; anything else is 404", async () => {
  const { deps } = seeded();
  const app = new Hono();
  mountPageRoutes(app, {
    pageStore: new PageStore(env!.store.db),
    builtins: deps,
    sources: {
      list: () => [],
      data: (name) => (name === "prom" ? { name, value: 3, at: "2026-10-20T00:00:00.000Z", error: null } : null),
      setPaused: () => null,
      remove: () => false
    }
  });
  const threads = await (await app.request(API_PATHS.agentPageData("threads"))).json() as { name: string; value: unknown[]; error: null };
  expect([threads.name, threads.value.length, threads.error]).toEqual(["threads", 2, null]);
  expect(await (await app.request(API_PATHS.agentPageData("prom"))).json()).toEqual({ name: "prom", value: 3, at: "2026-10-20T00:00:00.000Z", error: null });
  expect((await app.request(API_PATHS.agentPageData("nope"))).status).toBe(404);
  expect(await (await app.request(API_ROUTES.agentPageSources)).json()).toEqual({ sources: [] });
  const patch = (body: unknown) => app.request(API_PATHS.agentPageSource("prom"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await patch({ paused: "yes" })).status).toBe(400);
  expect((await patch({ paused: true })).status).toBe(404);
  expect((await app.request(API_PATHS.agentPageSource("prom"), { method: "DELETE" })).status).toBe(404);
});
