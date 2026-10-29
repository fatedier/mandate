import { expect, test } from "bun:test";
import { Hono } from "hono";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { mountCanvasRoutes } from "../src/server/modules/canvas/canvas-routes.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { getJson } from "./helpers/test-app.js";
import { stub } from "./helpers/typed.js";
import type { AppDeps } from "../src/server/app/deps.js";

// A thread's reports and canvases, for its Workers tab: what its manager
// wrote and what each of its workers wrote, archived ones too.

function seed() {
  const env = freshStoresEnv("md-canvas-thread-list-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const a = env.agentStore.createManagerThread("project-1 3.21 release");
  const b = env.agentStore.createManagerThread("project-1 docs");
  const w1 = seedFeature(env.features, projectId, { ownerThreadId: a.id, name: "release notes", tmuxWindowName: "notes" });
  const w2 = seedFeature(env.features, projectId, { ownerThreadId: a.id, name: "rollback drill", tmuxWindowName: "drill" });
  const w3 = seedFeature(env.features, projectId, { ownerThreadId: b.id, name: "docs site", tmuxWindowName: "docs" });
  const global = env.agentStore.getOrCreateThread("global", null);
  const made: Array<[string, string]> = [];
  const canvas = (title: string, scope: "manager" | "worker", scopeId: string | null, threadId: string) => {
    const created = canvasStore.create({ title, scope, scopeId, threadId });
    made.push([created.id, title]);
  };
  canvas("Release report", "worker", w1, env.agentStore.getOrCreateThread("worker", w1).id);
  canvas("Rollout plan", "manager", null, a.id);
  canvas("Drill report", "worker", w2, env.agentStore.getOrCreateThread("worker", w2).id);
  canvas("Docs plan", "manager", null, b.id);
  canvas("Docs report", "worker", w3, env.agentStore.getOrCreateThread("worker", w3).id);
  canvas("Weekly summary", "manager", null, global.id);
  // One minute apart, in the order made: the newest last.
  made.forEach(([id], i) => {
    env.store.db.prepare("update canvas_documents set updated_at = ? where id = ?").run(`2026-10-28T0${i}:00:00.000Z`, id);
  });
  env.features.archive(w2);
  return { env, canvasStore, a, b, w1, w2 };
}

test("a thread's canvases are its manager's and its workers', active and archived, newest first", () => {
  const { env, canvasStore, a, w1, w2 } = seed();
  try {
    expect(canvasStore.listForThread(a.id, [w1, w2]).map((c) => c.title)).toEqual(["Drill report", "Rollout plan", "Release report"]);
    expect(canvasStore.listForThread(a.id, []).map((c) => c.title)).toEqual(["Rollout plan"]);
  } finally {
    env.cleanup();
  }
});

test("the route lists them for the thread, and none for a thread with nothing", async () => {
  const { env, canvasStore, a } = seed();
  try {
    const app = new Hono();
    mountCanvasRoutes(app, stub<AppDeps>({ canvasStore, features: env.features }));
    const result = await getJson(app, `/api/agents/manager/threads/${a.id}/canvases`);
    expect(result.status).toBe(200);
    const canvases = result.body.canvases as Array<{ title: string; featureName: string | null }>;
    expect(canvases.map((c) => [c.title, c.featureName])).toEqual([
      ["Drill report", "rollback drill"],
      ["Rollout plan", null],
      ["Release report", "release notes"]
    ]);
    expect((await getJson(app, "/api/agents/manager/threads/thr_none/canvases")).body).toEqual({ canvases: [] });
  } finally {
    env.cleanup();
  }
});
