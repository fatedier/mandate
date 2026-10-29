import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { mountFeaturesRoutes } from "../src/server/modules/features/feature-routes.js";
import { buildPaneRuntimes, type PaneRuntimeRegistry } from "../src/server/runtime/pane-runtime-registry.js";
import { buildFeaturesTestApp, postJson } from "./helpers/test-app.js";
import { freshProjectEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";
import type { FeatureDto } from "../src/shared/api/features.js";

describe("POST /api/features/:id/pin", () => {
  function setup() {
    const db = new Database(":memory:");
    initializeProjectsSchema(db);
    initializeFeaturesSchema(db);
    initializeAgentSchema(db);
    const projects = new ProjectsStore(db);
    const features = new FeaturesStore(db);
    const projectId = seedProject(projects, { name: "p", workingDir: "/tmp/p", tmuxSessionName: "p" });
    const featureId = features.insert({
      projectId, name: "login", mode: "shared-cwd",
      branch: null, baseRef: null, worktreePath: null,
      tmuxWindowName: "login", ownership: "app"
    });
    const app = new Hono();
    // mountFeaturesRoutes deps — pass minimum needed for the pin endpoint:
    //   projects, features, broadcast (no-op), and stub for other required deps
    // Inspect FeaturesApiDeps interface in feature-routes.ts; use stubs for tmuxClient / paneRuntimes / etc.
    mountFeaturesRoutes(app, {
      projects, features,
      tmuxClient: stub<TmuxClient>(),
      paneRuntimes: stub<PaneRuntimeRegistry>(),
      broadcast: () => {}
    });
    return { app, features, featureId };
  }

  test("POST /api/features/:id/pin {pinned:true} sets pinned_at, returns feature with pinnedAt", async () => {
    const { app, features, featureId } = setup();
    const res = await app.request(`/api/features/${featureId}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true })
    });
    expect(res.status).toBe(200);
    const body: { feature: FeatureDto } = await res.json();
    expect(body.feature).toBeDefined();
    expect(body.feature.pinnedAt).toBeTruthy();
    expect(features.getById(featureId)!.pinnedAt).toBeTruthy();
  });

  test("POST /api/features/:id/pin {pinned:false} clears pinned_at", async () => {
    const { app, features, featureId } = setup();
    features.setPinned(featureId, true);
    const res = await app.request(`/api/features/${featureId}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: false })
    });
    expect(res.status).toBe(200);
    const body: { feature: FeatureDto } = await res.json();
    expect(body.feature.pinnedAt).toBeNull();
  });

  test("POST /api/features/:id/pin missing feature returns 404", async () => {
    const { app } = setup();
    const res = await app.request(`/api/features/feat-bogus/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true })
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/features/:id/pin without boolean returns 400", async () => {
    const { app, featureId } = setup();
    const res = await app.request(`/api/features/${featureId}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: "yes" })
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/features/:id/panes", () => {
  test("POST /api/features/:id/panes ensures a tmux shell pane for a feature", async () => {
    const env = freshProjectEnv("md-feature-pane-");
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
    expect(events).toStrictEqual([
      { type: "paneCreated", data: { featureId, paneId: res.body.paneId } }
    ]);
  });

  test("POST /api/features/:id/panes reuses an existing tmux pane", async () => {
    const env = freshProjectEnv("md-feature-pane-reuse-");
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
  });
});
