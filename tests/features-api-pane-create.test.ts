import { expect, test } from "bun:test";
import { buildFeaturesTestApp, postJson } from "./helpers/test-app.js";
import { freshProjectEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { buildPaneRuntimes } from "../src/server/runtime/pane-runtime-registry.js";

test("POST /api/features/:id/panes ensures a tmux shell pane for a feature", async () => {
  const env = freshProjectEnv("md-feature-pane-");
  try {
    const projectId = seedProject(env.projects, {
      workingDir: env.dir,
      tmuxSessionName: "md-feature-pane"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "empty",
      tmuxWindowName: "empty"
    });
    const events: Array<{ type: string; data: unknown }> = [];
    const app = buildFeaturesTestApp({
      projects: env.projects,
      features: env.features,
      tmuxClient: env.tmux.client,
      paneRuntimes: buildPaneRuntimes({
        tmuxClient: env.tmux.client,
        projectsStore: env.projects,
        featuresStore: env.features
      }),
      broadcast: (event) => events.push(event)
    });

    const res = await postJson(app, `/api/features/${featureId}/panes`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(String(res.body.paneId)).toMatch(/^%/);
    expect(events).toEqual([
      { type: "paneCreated", data: { featureId, paneId: res.body.paneId } }
    ]);
  } finally {
    env.cleanup();
  }
});

test("POST /api/features/:id/panes reuses an existing tmux pane", async () => {
  const env = freshProjectEnv("md-feature-pane-reuse-");
  try {
    const projectId = seedProject(env.projects, {
      workingDir: env.dir,
      tmuxSessionName: "md-feature-pane-reuse"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "empty",
      tmuxWindowName: "empty"
    });
    const paneRuntimes = buildPaneRuntimes({
      tmuxClient: env.tmux.client,
      projectsStore: env.projects,
      featuresStore: env.features
    });
    const app = buildFeaturesTestApp({
      projects: env.projects,
      features: env.features,
      tmuxClient: env.tmux.client,
      paneRuntimes,
      broadcast: () => {}
    });

    const first = await postJson(app, `/api/features/${featureId}/panes`, {});
    const second = await postJson(app, `/api/features/${featureId}/panes`, {});
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  } finally {
    env.cleanup();
  }
});
