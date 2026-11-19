import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeWorkersSchema } from "../src/server/modules/workers/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { mountWorkersRoutes } from "../src/server/modules/workers/worker-routes.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { buildWorkersTestApp, postJson } from "./helpers/test-app.js";
import { freshProjectEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";
import type { WorkerDto } from "../src/shared/api/workers.js";

describe("POST /api/workers/:id/pin", () => {
  function setup() {
    const db = new Database(":memory:");
    initializeProjectsSchema(db);
    initializeWorkersSchema(db);
    initializeAgentSchema(db);
    const projects = new ProjectsStore(db);
    const workers = new WorkersStore(db);
    const projectId = seedProject(projects, { name: "p", workingDir: "/tmp/p", tmuxSessionName: "p" });
    const workerId = workers.insert({
      projectId, name: "login", mode: "shared-cwd",
      branch: null, baseRef: null, worktreePath: null,
      tmuxWindowName: "login", ownership: "app"
    });
    const app = new Hono();
    // mountWorkersRoutes deps — pass minimum needed for the pin endpoint:
    //   projects, workers, broadcast (no-op), and stub for other required deps
    // Inspect WorkersApiDeps interface in worker-routes.ts; use stubs for tmuxClient / tmuxRuntime / etc.
    mountWorkersRoutes(app, {
      projects, workers,
      tmuxClient: stub<TmuxClient>(),
      tmuxRuntime: stub<TmuxRuntime>(),
      broadcast: () => {}
    });
    return { app, workers, workerId };
  }

  test("POST /api/workers/:id/pin {pinned:true} sets pinned_at, returns worker with pinnedAt", async () => {
    const { app, workers, workerId } = setup();
    const res = await app.request(`/api/workers/${workerId}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true })
    });
    expect(res.status).toBe(200);
    const body: { worker: WorkerDto } = await res.json();
    expect(body.worker).toBeDefined();
    expect(body.worker.pinnedAt).toBeTruthy();
    expect(workers.getById(workerId)!.pinnedAt).toBeTruthy();
  });

  test("POST /api/workers/:id/pin {pinned:false} clears pinned_at", async () => {
    const { app, workers, workerId } = setup();
    workers.setPinned(workerId, true);
    const res = await app.request(`/api/workers/${workerId}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: false })
    });
    expect(res.status).toBe(200);
    const body: { worker: WorkerDto } = await res.json();
    expect(body.worker.pinnedAt).toBeNull();
  });

  test("POST /api/workers/:id/pin missing worker returns 404", async () => {
    const { app } = setup();
    const res = await app.request(`/api/workers/wkr-bogus/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true })
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/workers/:id/pin without boolean returns 400", async () => {
    const { app, workerId } = setup();
    const res = await app.request(`/api/workers/${workerId}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: "yes" })
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/workers/:id/panes", () => {
  test("POST /api/workers/:id/panes ensures a tmux shell pane for a worker", async () => {
    const env = freshProjectEnv("md-worker-pane-");
    const projectId = seedProject(env.projects, {
      workingDir: env.dir,
      tmuxSessionName: "md-worker-pane"
    });
    const workerId = seedWorker(env.workers, projectId, {
      name: "empty",
      tmuxWindowName: "empty"
    });
    const events: Array<{ type: string; data: unknown }> = [];
    const app = buildWorkersTestApp({
      projects: env.projects,
      workers: env.workers,
      tmuxClient: env.tmux.client,
      tmuxRuntime: new TmuxRuntime({
        tmuxClient: env.tmux.client,
        projectsStore: env.projects,
        workersStore: env.workers
      }),
      broadcast: (event) => events.push(event)
    });

    const res = await postJson(app, `/api/workers/${workerId}/panes`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(String(res.body.paneId)).toMatch(/^%/);
    expect(events).toStrictEqual([
      { type: "paneCreated", data: { workerId, paneId: res.body.paneId } }
    ]);
  });

  test("POST /api/workers/:id/panes reuses an existing tmux pane", async () => {
    const env = freshProjectEnv("md-worker-pane-reuse-");
    const projectId = seedProject(env.projects, {
      workingDir: env.dir,
      tmuxSessionName: "md-worker-pane-reuse"
    });
    const workerId = seedWorker(env.workers, projectId, {
      name: "empty",
      tmuxWindowName: "empty"
    });
    const tmuxRuntime = new TmuxRuntime({
      tmuxClient: env.tmux.client,
      projectsStore: env.projects,
      workersStore: env.workers
    });
    const app = buildWorkersTestApp({
      projects: env.projects,
      workers: env.workers,
      tmuxClient: env.tmux.client,
      tmuxRuntime,
      broadcast: () => {}
    });

    const first = await postJson(app, `/api/workers/${workerId}/panes`, {});
    const second = await postJson(app, `/api/workers/${workerId}/panes`, {});
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});
