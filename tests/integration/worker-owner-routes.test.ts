import { expect, test } from "bun:test";
import { tmuxListWindows } from "../../src/server/platform/tmux/tmux.js";
import { TmuxRuntime } from "../../src/server/runtime/runtimes/tmux-runtime.js";
import { buildWorkersTestApp, buildProjectsTestApp, deleteJson, postJson } from "../helpers/test-app.js";
import { freshProjectEnv } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/temp.js";

function makeApps() {
  const env = freshProjectEnv("md-owner-routes-");
  const wd = tempDir("md-wd-");
  const deps = {
    projects: env.projects, workers: env.workers, agentStore: env.agentStore,
    tmuxClient: env.tmux.client, broadcast: () => {},
    tmuxRuntime: new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers })
  };
  return {
    ...env, wd,
    projectsApp: buildProjectsTestApp(deps),
    workersApp: buildWorkersTestApp(deps)
  };
}

const projectIds = new WeakMap<object, string>();
async function createWorker(e: ReturnType<typeof makeApps>, body: Record<string, unknown>) {
  let projectId = projectIds.get(e);
  if (!projectId) {
    const proj = await postJson(e.projectsApp, "/api/projects", { name: "P", workingDir: e.wd });
    projectId = proj.body.id as string;
    projectIds.set(e, projectId);
  }
  return postJson(e.workersApp, `/api/projects/${projectId}/workers`, { mode: "shared-cwd", ...body });
}

test("POST /api/projects/:id/workers (shared-cwd) creates window in session", async () => {
  const wd = tempDir("md-wd-");
  const { projectsApp, workersApp, tmux } = makeApps();
  const proj = await postJson(projectsApp, "/api/projects", { name: "P", workingDir: wd });
  const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
    { name: "Worker 1", mode: "shared-cwd" });

  expect(worker.status).toBe(200);
  expect(worker.body.name).toBe("Worker 1");
  expect(worker.body.mode).toBe("shared-cwd");
  expect(worker.body.tmuxWindowName).toBe("worker_1");

  const windows = await tmuxListWindows("md-p", tmux.client);
  expect(windows.includes("worker_1")).toBeTruthy();
});

test("DELETE /api/workers/:id soft-archives", async () => {
  const wd = tempDir("md-wd-");
  const { projectsApp, workersApp, workers } = makeApps();
  const proj = await postJson(projectsApp, "/api/projects", { name: "P", workingDir: wd });
  const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
    { name: "F", mode: "shared-cwd" });

  const r = await deleteJson(workersApp, `/api/workers/${worker.body.id}`);

  expect(r.status).toBe(200);
  const row = workers.getById(worker.body.id);
  expect(row!.archivedAt).toBeTruthy();
});

test("create route: a given open manager thread owns the new worker", async () => {
  const e = makeApps();
  const t = e.agentStore.createManagerThread("Release");
  const worker = await createWorker(e, { name: "Notes", ownerThreadId: t.id });
  expect(worker.status).toBe(200);
  expect(worker.body.ownerThreadId).toBe(t.id);
});

test("create route: a stale or archived ownerThreadId is ignored and a thread named after the worker opens", async () => {
  const e = makeApps();
  const t = e.agentStore.createManagerThread("Old");
  e.agentStore.archiveThread(t.id);
  const worker = await createWorker(e, { name: "Notes", ownerThreadId: t.id });
  expect(worker.status).toBe(200);
  expect(worker.body.ownerThreadId).not.toBe(t.id);
  expect(e.agentStore.getThreadById(worker.body.ownerThreadId)?.title).toBe("Notes");
  const stale = await createWorker(e, { name: "Other", ownerThreadId: "thr_missing" });
  expect(e.agentStore.getThreadById(stale.body.ownerThreadId)?.title).toBe("Other");
});
