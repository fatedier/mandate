import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { mountFeaturesRoutes } from "../src/server/modules/features/feature-routes.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", isGit: false, gitRemote: null
  });
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
    tmuxClient: {} as any,
    paneRuntimes: {} as any,
    broadcast: () => {}
  } as any);
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
  const body = await res.json() as any;
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
  const body = await res.json() as any;
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
