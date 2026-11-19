import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { projectSessionNameForDataDir } from "../../src/server/platform/naming/names.js";
import { tmuxHasSession, tmuxKillSession, tmuxNewSession } from "../../src/server/platform/tmux/tmux.js";
import { buildProjectsTestApp, deleteJson, postJson } from "../helpers/test-app.js";
import { freshProjectEnv, seedProject } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/temp.js";

function makeApp() {
  const env = freshProjectEnv("md-test-");
  const app = buildProjectsTestApp({
    projects: env.projects, workers: env.workers,
    tmuxClient: env.tmux.client, broadcast: () => {},
    sessionDataDir: env.dir
  });
  return { app, dir: env.dir, projects: env.projects, workers: env.workers, tmux: env.tmux, cleanup: env.cleanup };
}

test("POST /api/projects creates DB row and tmux session", async () => {
  const workingDir = tempDir("md-wd-");
  const { app, dir, projects, tmux } = makeApp();
  const r = await postJson(app, "/api/projects", { name: "Test App", workingDir });
  const expectedSession = projectSessionNameForDataDir("Test App", dir);

  expect(r.status).toBe(200);
  expect(r.body.id).toBeTruthy();
  expect(r.body.name).toBe("Test App");
  expect(r.body.tmuxSessionName).toBe(expectedSession);

  const row = projects.getById(r.body.id);
  expect(row).toBeTruthy();
  expect(row!.workingDir).toBe(workingDir);

  expect(await tmuxHasSession(expectedSession, tmux.client)).toBeTruthy();
});

test("POST /api/projects creates missing workingDir", async () => {
  const { app } = makeApp();
  const parent = tempDir("md-new-parent-");
  const workingDir = path.join(parent, "nested", "project");
  const r = await postJson(app, "/api/projects", {
    name: "X", workingDir
  });

  expect(r.status).toBe(200);
  expect(fs.statSync(workingDir).isDirectory()).toBe(true);
  expect(r.body.workingDir).toBe(workingDir);
});

test("POST /api/projects resolves tmuxSessionName collision via suffix", async () => {
  const wd1 = tempDir("md-wd-");
  const wd2 = tempDir("md-wd-");
  const { app, dir } = makeApp();
  const r1 = await postJson(app, "/api/projects", { name: "Same", workingDir: wd1 });
  const r2 = await postJson(app, "/api/projects", { name: "Same!", workingDir: wd2 });

  expect(r1.body.tmuxSessionName).toBe(projectSessionNameForDataDir("Same", dir));
  expect(r2.body.tmuxSessionName).toBe(projectSessionNameForDataDir("Same", dir, 2));
});

test("POST /api/projects/reorder persists active project order", async () => {
  const wd1 = tempDir("md-wd-");
  const wd2 = tempDir("md-wd-");
  const { app, projects } = makeApp();
  const p1 = await postJson(app, "/api/projects", { name: "P1", workingDir: wd1 });
  const p2 = await postJson(app, "/api/projects", { name: "P2", workingDir: wd2 });

  expect(projects.listActive().map((project) => project.id)).toEqual([p2.body.id, p1.body.id]);

  const reordered = await postJson(app, "/api/projects/reorder", {
    projectIds: [p1.body.id, p2.body.id]
  });

  expect(reordered.status).toBe(200);
  expect(reordered.body.projects.map((project: { id: string }) => project.id)).toEqual([p1.body.id, p2.body.id]);
  expect(projects.getById(p1.body.id)!.sortOrder).toBeLessThan(projects.getById(p2.body.id)!.sortOrder);

  expect(projects.listActive().map((project) => project.id)).toEqual([p1.body.id, p2.body.id]);
});

test("POST /api/projects/reorder rejects partial and duplicate project ids", async () => {
  const wd1 = tempDir("md-wd-");
  const wd2 = tempDir("md-wd-");
  const { app } = makeApp();
  const p1 = await postJson(app, "/api/projects", { name: "P1", workingDir: wd1 });
  await postJson(app, "/api/projects", { name: "P2", workingDir: wd2 });

  const partial = await postJson(app, "/api/projects/reorder", { projectIds: [p1.body.id] });
  expect(partial.status).toBe(400);
  expect(partial.body.error).toBe("projectIds must include every active project");

  const duplicate = await postJson(app, "/api/projects/reorder", { projectIds: [p1.body.id, p1.body.id] });
  expect(duplicate.status).toBe(400);
  expect(duplicate.body.error).toBe("projectIds must be unique");
});

test("DELETE /api/projects/:id soft-archives", async () => {
  const wd = tempDir("md-wd-");
  const { app, projects, tmux } = makeApp();
  const created = await postJson(app, "/api/projects", { name: "DelMe", workingDir: wd });
  const r = await deleteJson(app, `/api/projects/${created.body.id}`);

  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  const row = projects.getById(created.body.id);
  expect(row!.archivedAt).toBeTruthy();
  // tmux session should still exist (no killTmux flag)
  expect(await tmuxHasSession(created.body.tmuxSessionName, tmux.client)).toBeTruthy();
});

test("DELETE /api/projects/:id?killTmux=true kills current app-owned session", async () => {
  const wd = tempDir("md-wd-");
  const { app, projects, tmux } = makeApp();
  const created = await postJson(app, "/api/projects", { name: "KillMe", workingDir: wd });
  const r = await deleteJson(app, `/api/projects/${created.body.id}?killTmux=true`);

  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  expect(projects.getById(created.body.id)!.archivedAt).toBeTruthy();
  expect(await tmuxHasSession(created.body.tmuxSessionName, tmux.client)).toBe(false);
});

test("DELETE /api/projects/:id?killTmux=true does not kill untracked app-owned md session", async () => {
  const wd = tempDir("md-wd-");
  const { app, projects, tmux } = makeApp();
  await tmuxNewSession("md-untracked", wd, tmux.client);
  const id = seedProject(projects, { name: "Untracked", workingDir: wd, tmuxSessionName: "md-untracked" });

  const r = await deleteJson(app, `/api/projects/${id}?killTmux=true`);

  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  expect(projects.getById(id)!.archivedAt).toBeTruthy();
  expect(await tmuxHasSession("md-untracked", tmux.client)).toBe(true);
});

test("DELETE /api/projects/:id cascades archive to active workers", async () => {
  const wd = tempDir("md-wd-");
  const { app, workers } = makeApp();
  const created = await postJson(app, "/api/projects", { name: "Cascade", workingDir: wd });
  const projectId = created.body.id;
  // Seed two active workers directly via the store (faster than going via API).
  const f1 = workers.insert({
    projectId, name: "f1", mode: "shared-cwd", branch: null, worktreePath: null,
    tmuxWindowName: "f1", ownership: "app"
  });
  const f2 = workers.insert({
    projectId, name: "f2", mode: "shared-cwd", branch: null, worktreePath: null,
    tmuxWindowName: "f2", ownership: "app"
  });

  const r = await deleteJson(app, `/api/projects/${projectId}`);
  expect(r.status).toBe(200);

  // Both workers must be archived now — no active worker should outlive its project.
  expect(workers.getById(f1)!.archivedAt).toBeTruthy();
  expect(workers.getById(f2)!.archivedAt).toBeTruthy();
  expect(workers.listActiveByProject(projectId).length).toBe(0);
});

test("POST /api/projects/:id/reconcile rebuilds tmux session for app-owned project", async () => {
  const wd = tempDir("md-wd-");
  const { app, tmux } = makeApp();
  const created = await postJson(app, "/api/projects", { name: "Restore", workingDir: wd });
  const sessionName = created.body.tmuxSessionName;

  await tmuxKillSession(sessionName, tmux.client);
  expect(await tmuxHasSession(sessionName, tmux.client)).toBe(false);

  const r = await postJson(app, `/api/projects/${created.body.id}/reconcile`, {});
  expect(r.status).toBe(200);
  expect(r.body.rebuilt).toBe(true);
  expect(await tmuxHasSession(sessionName, tmux.client)).toBe(true);
});
