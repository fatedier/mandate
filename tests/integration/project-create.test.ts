import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { projectSessionNameForDataDir } from "../../src/server/platform/naming/names.js";
import { tmuxHasSession, tmuxNewSession } from "../../src/server/platform/tmux/tmux.js";
import { buildProjectsTestApp, deleteJson, getJson, postJson } from "../helpers/test-app.js";
import { freshProjectEnv } from "../helpers/fixtures.js";

function makeApp() {
  const env = freshProjectEnv("md-test-");
  const app = buildProjectsTestApp({
    projects: env.projects, features: env.features,
    tmuxClient: env.tmux.client, broadcast: () => {},
    sessionDataDir: env.dir
  });
  return { app, dir: env.dir, projects: env.projects, features: env.features, tmux: env.tmux, cleanup: env.cleanup };
}

test("POST /api/projects creates DB row and tmux session", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, dir, projects, tmux, cleanup } = makeApp();
  try {
    const r = await postJson(app, "/api/projects", { name: "Test App", workingDir });
    const expectedSession = projectSessionNameForDataDir("Test App", dir);

    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
    expect(r.body.name).toBe("Test App");
    expect(r.body.tmuxSessionName).toBe(expectedSession);

    const row = projects.getById(r.body.id);
    expect(row).toBeTruthy();
    expect(row!.workingDir).toBe(workingDir);

    expect(tmuxHasSession(expectedSession, tmux.client)).toBeTruthy();
  } finally {
    cleanup();
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test("POST /api/projects creates missing workingDir", async () => {
  const { app, cleanup } = makeApp();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "md-new-parent-"));
  const workingDir = path.join(parent, "nested", "project");
  try {
    const r = await postJson(app, "/api/projects", {
      name: "X", workingDir
    });

    expect(r.status).toBe(200);
    expect(fs.statSync(workingDir).isDirectory()).toBe(true);
    expect(r.body.workingDir).toBe(workingDir);
  } finally {
    cleanup();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("POST /api/projects resolves tmuxSessionName collision via suffix", async () => {
  const wd1 = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const wd2 = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, dir, cleanup } = makeApp();
  try {
    const r1 = await postJson(app, "/api/projects", { name: "Same", workingDir: wd1 });
    const r2 = await postJson(app, "/api/projects", { name: "Same!", workingDir: wd2 });

    expect(r1.body.tmuxSessionName).toBe(projectSessionNameForDataDir("Same", dir));
    expect(r2.body.tmuxSessionName).toBe(projectSessionNameForDataDir("Same", dir, 2));
  } finally {
    cleanup();
    fs.rmSync(wd1, { recursive: true, force: true });
    fs.rmSync(wd2, { recursive: true, force: true });
  }
});

test("GET /api/projects lists active projects", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, cleanup } = makeApp();
  try {
    await postJson(app, "/api/projects", { name: "P1", workingDir: wd });
    const list = await getJson(app, "/api/projects");

    expect(list.status).toBe(200);
    expect(list.body.projects.length).toBe(1);
    expect(list.body.projects[0].name).toBe("P1");
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("POST /api/projects/reorder persists active project order", async () => {
  const wd1 = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const wd2 = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, projects, cleanup } = makeApp();
  try {
    const p1 = await postJson(app, "/api/projects", { name: "P1", workingDir: wd1 });
    const p2 = await postJson(app, "/api/projects", { name: "P2", workingDir: wd2 });

    const initial = await getJson(app, "/api/projects");
    expect(initial.body.projects.map((project: { id: string }) => project.id)).toEqual([p2.body.id, p1.body.id]);

    const reordered = await postJson(app, "/api/projects/reorder", {
      projectIds: [p1.body.id, p2.body.id]
    });

    expect(reordered.status).toBe(200);
    expect(reordered.body.projects.map((project: { id: string }) => project.id)).toEqual([p1.body.id, p2.body.id]);
    expect(projects.getById(p1.body.id)!.sortOrder).toBeLessThan(projects.getById(p2.body.id)!.sortOrder);

    const listed = await getJson(app, "/api/projects");
    expect(listed.body.projects.map((project: { id: string }) => project.id)).toEqual([p1.body.id, p2.body.id]);
  } finally {
    cleanup();
    fs.rmSync(wd1, { recursive: true, force: true });
    fs.rmSync(wd2, { recursive: true, force: true });
  }
});

test("POST /api/projects/reorder rejects partial and duplicate project ids", async () => {
  const wd1 = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const wd2 = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, cleanup } = makeApp();
  try {
    const p1 = await postJson(app, "/api/projects", { name: "P1", workingDir: wd1 });
    await postJson(app, "/api/projects", { name: "P2", workingDir: wd2 });

    const partial = await postJson(app, "/api/projects/reorder", { projectIds: [p1.body.id] });
    expect(partial.status).toBe(400);
    expect(partial.body.error).toBe("projectIds must include every active project");

    const duplicate = await postJson(app, "/api/projects/reorder", { projectIds: [p1.body.id, p1.body.id] });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toBe("projectIds must be unique");
  } finally {
    cleanup();
    fs.rmSync(wd1, { recursive: true, force: true });
    fs.rmSync(wd2, { recursive: true, force: true });
  }
});

test("DELETE /api/projects/:id soft-archives", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, projects, tmux, cleanup } = makeApp();
  try {
    const created = await postJson(app, "/api/projects", { name: "DelMe", workingDir: wd });
    const r = await deleteJson(app, `/api/projects/${created.body.id}`);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const row = projects.getById(created.body.id);
    expect(row!.archivedAt).toBeTruthy();
    // tmux session should still exist (no killTmux flag)
    expect(tmuxHasSession(created.body.tmuxSessionName, tmux.client)).toBeTruthy();
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("DELETE /api/projects/:id?killTmux=true kills current app-owned session", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, projects, tmux, cleanup } = makeApp();
  try {
    const created = await postJson(app, "/api/projects", { name: "KillMe", workingDir: wd });
    const r = await deleteJson(app, `/api/projects/${created.body.id}?killTmux=true`);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(projects.getById(created.body.id)!.archivedAt).toBeTruthy();
    expect(tmuxHasSession(created.body.tmuxSessionName, tmux.client)).toBe(false);
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("DELETE /api/projects/:id?killTmux=true does not kill untracked app-owned md session", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, projects, tmux, cleanup } = makeApp();
  try {
    tmuxNewSession("md-untracked", wd, tmux.client);
    const id = projects.insert({
      name: "Untracked",
      workingDir: wd,
      isGit: false,
      gitRemote: null,
      tmuxSessionName: "md-untracked",
      ownership: "app"
    });

    const r = await deleteJson(app, `/api/projects/${id}?killTmux=true`);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(projects.getById(id)!.archivedAt).toBeTruthy();
    expect(tmuxHasSession("md-untracked", tmux.client)).toBe(true);
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("DELETE /api/projects/:id cascades archive to active features", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, features, cleanup } = makeApp();
  try {
    const created = await postJson(app, "/api/projects", { name: "Cascade", workingDir: wd });
    const projectId = created.body.id;
    // Seed two active features directly via the store (faster than going via API).
    const f1 = features.insert({
      projectId, name: "f1", mode: "shared-cwd", branch: null, worktreePath: null,
      tmuxWindowName: "f1", ownership: "app"
    });
    const f2 = features.insert({
      projectId, name: "f2", mode: "shared-cwd", branch: null, worktreePath: null,
      tmuxWindowName: "f2", ownership: "app"
    });

    const r = await deleteJson(app, `/api/projects/${projectId}`);
    expect(r.status).toBe(200);

    // Both features must be archived now — no active feature should outlive its project.
    expect(features.getById(f1)!.archivedAt).toBeTruthy();
    expect(features.getById(f2)!.archivedAt).toBeTruthy();
    expect(features.listActiveByProject(projectId).length).toBe(0);
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});
