import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { tmuxHasSession, tmuxKillSession } from "../../src/server/platform/tmux/tmux.js";
import { buildProjectsTestApp, postJson } from "../helpers/test-app.js";
import { freshProjectEnv } from "../helpers/fixtures.js";

function makeApp() {
  const env = freshProjectEnv("md-db-");
  const app = buildProjectsTestApp({
    projects: env.projects, features: env.features,
    tmuxClient: env.tmux.client, broadcast: () => {}
  });
  return { app, projects: env.projects, features: env.features, tmux: env.tmux, cleanup: env.cleanup };
}

test("POST /api/projects/:id/reconcile rebuilds tmux session for app-owned project", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, tmux, cleanup } = makeApp();
  try {
    const created = await postJson(app, "/api/projects", { name: "Restore", workingDir: wd });
    const sessionName = created.body.tmuxSessionName;

    tmuxKillSession(sessionName, tmux.client);
    expect(tmuxHasSession(sessionName, tmux.client)).toBe(false);

    const r = await postJson(app, `/api/projects/${created.body.id}/reconcile`, {});
    expect(r.status).toBe(200);
    expect(r.body.rebuilt).toBe(true);
    expect(tmuxHasSession(sessionName, tmux.client)).toBe(true);
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("POST /api/projects/:id/reconcile reports broken for adopted project whose session is gone", async () => {
  const { app, projects, cleanup } = makeApp();
  try {
    const id = projects.insert({
      name: "Adopted", workingDir: "/tmp",
      isGit: false, gitRemote: null,
      tmuxSessionName: "ghost-session", ownership: "adopted"
    });

    const r = await postJson(app, `/api/projects/${id}/reconcile`, {});
    expect(r.status).toBe(200);
    expect(r.body.broken).toBe(true);
  } finally {
    cleanup();
  }
});
