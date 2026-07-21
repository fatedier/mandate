import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { tmuxListWindows } from "../../src/server/platform/tmux/tmux.js";
import {
  buildFeaturesTestApp,
  buildProjectsTestApp,
  deleteJson,
  postJson
} from "../helpers/test-app.js";
import { freshProjectEnv } from "../helpers/fixtures.js";

function makeApps() {
  const env = freshProjectEnv("md-test-");
  const deps = {
    projects: env.projects, features: env.features,
    tmuxClient: env.tmux.client, broadcast: () => {}
  };
  return {
    projectsApp: buildProjectsTestApp(deps),
    featuresApp: buildFeaturesTestApp(deps),
    projects: env.projects, features: env.features, tmux: env.tmux, cleanup: env.cleanup
  };
}

test("POST /api/projects/:id/features (shared-cwd) creates window in session", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { projectsApp, featuresApp, tmux, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "P", workingDir: wd });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "Feat 1", mode: "shared-cwd" });

    expect(feat.status).toBe(200);
    expect(feat.body.name).toBe("Feat 1");
    expect(feat.body.mode).toBe("shared-cwd");
    expect(feat.body.tmuxWindowName).toBe("feat_1");

    const windows = tmuxListWindows("md-p", tmux.client);
    expect(windows.includes("feat_1")).toBeTruthy();
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("DELETE /api/features/:id soft-archives", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  const { projectsApp, featuresApp, features, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "P", workingDir: wd });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "F", mode: "shared-cwd" });

    const r = await deleteJson(featuresApp, `/api/features/${feat.body.id}`);

    expect(r.status).toBe(200);
    const row = features.getById(feat.body.id);
    expect(row!.archivedAt).toBeTruthy();
  } finally {
    cleanup();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});
