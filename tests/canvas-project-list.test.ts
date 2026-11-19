import { expect, test } from "bun:test";
import { Hono } from "hono";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { mountCanvasRoutes } from "../src/server/modules/canvas/canvas-routes.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { getJson } from "./helpers/test-app.js";
import { stub } from "./helpers/typed.js";
import type { AppDeps } from "../src/server/app/deps.js";

// A project's reports, for its page: the canvases tagged with it, newest
// first, a few of them and how many there are.

function seed() {
  const env = freshStoresEnv("md-canvas-project-list-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const atlas = seedProject(env.projects, { name: "atlas-api", tmuxSessionName: "md-atlas-api" });
  const search = seedProject(env.projects, { name: "search-server", tmuxSessionName: "md-search-server" });
  const thread = env.agentStore.createManagerThread("atlas-api release");
  const worker = seedWorker(env.workers, atlas, { ownerThreadId: thread.id, name: "release notes", tmuxWindowName: "notes" });
  const workerThread = env.agentStore.getOrCreateThread("worker", worker).id;
  const made: string[] = [];
  const canvas = (title: string, projectId: string | null, scope: "manager" | "worker") => {
    made.push(canvasStore.create({ title, scope, scopeId: scope === "worker" ? worker : null, threadId: scope === "worker" ? workerThread : thread.id, projectId }).id);
  };
  canvas("Release report", atlas, "worker");
  canvas("Rollout plan", atlas, "manager");
  canvas("Search tuning", search, "manager");
  canvas("Drill report", atlas, "worker");
  canvas("Weekly summary", null, "manager");
  canvas("Docs report", atlas, "worker");
  canvas("Cut-over plan", atlas, "manager");
  // One hour apart, in the order made: the newest last.
  made.forEach((id, i) => {
    env.store.db.prepare("update canvas_documents set updated_at = ? where id = ?").run(`2026-10-28T${String(i).padStart(2, "0")}:00:00.000Z`, id);
  });
  return { env, canvasStore, atlas, search };
}

test("a project's canvases are those tagged with it, newest first, at most the limit, with how many there are", () => {
  const { canvasStore, atlas, search } = seed();
  const listed = canvasStore.listForProject(atlas, 4);
  expect(listed.canvases.map((c) => c.title)).toEqual(["Cut-over plan", "Docs report", "Drill report", "Rollout plan"]);
  expect(listed.total).toBe(5);
  expect(canvasStore.listForProject(search, 4)).toMatchObject({ total: 1, canvases: [{ title: "Search tuning" }] });
  expect(canvasStore.listForProject("prj_none", 4)).toEqual({ canvases: [], total: 0 });
});

test("the route answers with the newest four by default and keeps the limit to 1..50", async () => {
  const { env, canvasStore, atlas } = seed();
  const app = new Hono();
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore, workers: env.workers }));
  const titles = async (query: string) => {
    const result = await getJson(app, `/api/projects/${atlas}/canvases${query}`);
    expect(result.status).toBe(200);
    expect(result.body.total).toBe(5);
    return (result.body.canvases as Array<{ title: string }>).map((c) => c.title);
  };
  expect(await titles("")).toHaveLength(4);
  expect(await titles("?limit=2")).toEqual(["Cut-over plan", "Docs report"]);
  expect(await titles("?limit=0")).toHaveLength(4);
  expect(await titles("?limit=abc")).toHaveLength(4);
  expect(await titles("?limit=500")).toHaveLength(5);
});

test("a worker's canvas with no project of its own is its worker's project's, as every canvas list says", () => {
  const { env, canvasStore, atlas } = seed();
  const thread = env.agentStore.createManagerThread("atlas-api notes");
  const worker = seedWorker(env.workers, atlas, { ownerThreadId: thread.id, name: "old notes", tmuxWindowName: "old-notes" });
  const made = canvasStore.create({ title: "Untagged notes", scope: "worker", scopeId: worker, threadId: env.agentStore.getOrCreateThread("worker", worker).id, projectId: null });
  env.store.db.prepare("update canvas_documents set updated_at = ? where id = ?").run("2026-10-29T00:00:00.000Z", made.id);
  const listed = canvasStore.listForProject(atlas, 4);
  expect(listed.canvases[0]).toMatchObject({ title: "Untagged notes", projectId: atlas });
  expect(listed.total).toBe(6);
});

test("the route never answers with more than fifty", async () => {
  const { env, canvasStore, search } = seed();
  const thread = env.agentStore.createManagerThread("search-server tuning");
  for (let i = 0; i < 51; i++) canvasStore.create({ title: `Run ${i}`, scope: "manager", scopeId: null, threadId: thread.id, projectId: search });
  const app = new Hono();
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore, workers: env.workers }));
  const result = await getJson(app, `/api/projects/${search}/canvases?limit=500`);
  expect((result.body.canvases as unknown[]).length).toBe(50);
  expect(result.body.total).toBe(52);
});
