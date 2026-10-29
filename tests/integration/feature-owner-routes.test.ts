import { expect, test } from "bun:test";
import { tmuxListWindows, tmuxNewSession, tmuxNewWindow } from "../../src/server/platform/tmux/tmux.js";
import { buildPaneRuntimes } from "../../src/server/runtime/pane-runtime-registry.js";
import { buildFeaturesTestApp, buildProjectsTestApp, deleteJson, postJson } from "../helpers/test-app.js";
import { freshProjectEnv } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/temp.js";

function makeApps() {
  const env = freshProjectEnv("md-owner-routes-");
  const wd = tempDir("md-wd-");
  const deps = {
    projects: env.projects, features: env.features, agentStore: env.agentStore,
    tmuxClient: env.tmux.client, broadcast: () => {},
    paneRuntimes: buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features })
  };
  return {
    ...env, wd,
    projectsApp: buildProjectsTestApp(deps),
    featuresApp: buildFeaturesTestApp(deps)
  };
}

const projectIds = new WeakMap<object, string>();
async function createFeature(e: ReturnType<typeof makeApps>, body: Record<string, unknown>) {
  let projectId = projectIds.get(e);
  if (!projectId) {
    const proj = await postJson(e.projectsApp, "/api/projects", { name: "P", workingDir: e.wd });
    projectId = proj.body.id as string;
    projectIds.set(e, projectId);
  }
  return postJson(e.featuresApp, `/api/projects/${projectId}/features`, { mode: "shared-cwd", ...body });
}

test("POST /api/projects/:id/features (shared-cwd) creates window in session", async () => {
  const wd = tempDir("md-wd-");
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
  }
});

test("DELETE /api/features/:id soft-archives", async () => {
  const wd = tempDir("md-wd-");
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
  }
});

test("create route: a given open manager thread owns the new worker", async () => {
  const e = makeApps();
  try {
    const t = e.agentStore.createManagerThread("Release");
    const feat = await createFeature(e, { name: "Notes", ownerThreadId: t.id });
    expect(feat.status).toBe(200);
    expect(feat.body.ownerThreadId).toBe(t.id);
  } finally { e.cleanup(); }
});

test("create route: a stale or archived ownerThreadId is ignored and a thread named after the worker opens", async () => {
  const e = makeApps();
  try {
    const t = e.agentStore.createManagerThread("Old");
    e.agentStore.archiveThread(t.id);
    const feat = await createFeature(e, { name: "Notes", ownerThreadId: t.id });
    expect(feat.status).toBe(200);
    expect(feat.body.ownerThreadId).not.toBe(t.id);
    expect(e.agentStore.getThreadById(feat.body.ownerThreadId)?.title).toBe("Notes");
    const stale = await createFeature(e, { name: "Other", ownerThreadId: "thr_missing" });
    expect(e.agentStore.getThreadById(stale.body.ownerThreadId)?.title).toBe("Other");
  } finally { e.cleanup(); }
});

test("restore route: a worker whose thread is gone comes back with a thread of its own", async () => {
  const e = makeApps();
  try {
    const t = e.agentStore.createManagerThread("Release");
    const feat = await createFeature(e, { name: "Notes", ownerThreadId: t.id });
    const archived = await deleteJson(e.featuresApp, `/api/features/${feat.body.id}`);
    expect(archived.status).toBe(200);
    e.agentStore.archiveThread(t.id);
    const restored = await postJson(e.featuresApp, `/api/features/${feat.body.id}/restore`, {});
    expect(restored.status).toBe(200);
    const owner = restored.body.feature.ownerThreadId as string;
    expect(owner).not.toBe(t.id);
    expect(e.agentStore.getThreadById(owner)?.title).toBe("Notes");
    expect(e.features.getById(feat.body.id)?.ownerThreadId).toBe(owner);
  } finally { e.cleanup(); }
});

test("adopt: an adopted project's windows become workers of one thread named after the project", async () => {
  const e = makeApps();
  try {
    tmuxNewSession("adopt-owner-session", "/tmp", e.tmux.client);
    tmuxNewWindow("adopt-owner-session", "editor", "/tmp", e.tmux.client);
    const r = await postJson(e.projectsApp, "/api/projects/adopt", { sessionName: "adopt-owner-session", projectName: "Real Project", workingDir: e.wd });
    expect(r.status).toBe(200);
    const owners = new Set(e.features.listActiveByProject(r.body.id).map((f) => f.ownerThreadId));
    expect(owners.size).toBe(1);
    const [owner] = [...owners];
    expect(owner).not.toBe(null);
    expect(e.agentStore.getThreadById(owner!)?.title).toBe("Real Project");
  } finally { e.cleanup(); }
});
