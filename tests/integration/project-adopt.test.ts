import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { tmuxNewSession, tmuxNewWindow } from "../../src/server/platform/tmux/tmux.js";
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

test("POST /api/projects/adopt creates project + features for each window", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, features, tmux, cleanup } = makeApp();
  try {
    tmuxNewSession("my-real-session", "/tmp", tmux.client);
    tmuxNewWindow("my-real-session", "editor", "/tmp", tmux.client);
    tmuxNewWindow("my-real-session", "server", "/tmp", tmux.client);

    const r = await postJson(app, "/api/projects/adopt",
      { sessionName: "my-real-session", projectName: "Real Project", workingDir: wd });

    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Real Project");
    expect(r.body.ownership).toBe("adopted");
    expect(r.body.tmuxSessionName).toBe("my-real-session");

    const featureRows = features.listActiveByProject(r.body.id);
    const windowNames = featureRows.map((f) => f.tmuxWindowName).sort();
    expect(windowNames.includes("editor")).toBeTruthy();
    expect(windowNames.includes("server")).toBeTruthy();
    for (const f of featureRows) {
      expect(f.mode).toBe("shared-cwd");
      expect(f.ownership).toBe("adopted");
    }
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("POST /api/projects/adopt rejects when session does not exist", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, cleanup } = makeApp();
  try {
    const r = await postJson(app, "/api/projects/adopt",
      { sessionName: "nope", projectName: "Nope", workingDir: wd });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/session/i);
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("POST /api/projects/adopt rejects when sessionName is already managed", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { app, projects, tmux, cleanup } = makeApp();
  try {
    tmuxNewSession("md-existing", "/tmp", tmux.client);
    projects.insert({
      name: "Existing", workingDir: "/tmp",
      isGit: false, gitRemote: null,
      tmuxSessionName: "md-existing", ownership: "app"
    });

    const r = await postJson(app, "/api/projects/adopt",
      { sessionName: "md-existing", projectName: "TryAgain", workingDir: wd });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/already (managed|adopted|in use)/i);
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});
