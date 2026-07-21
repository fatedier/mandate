import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { mountFeaturesRoutes } from "../src/server/modules/features/feature-routes.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", gitRemote: null, isGit: false
  });
  const featureId = features.insert({
    projectId, name: "feat-x", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "feat-x", ownership: "app"
  });
  // Note: features.insert() already creates the 1:1 work_item row
  const emitted: Array<{ event: string; data: any }> = [];
  const sse = { emit: (event: string, data: any) => emitted.push({ event, data }) } as any;
  const app = new Hono();
  mountFeaturesRoutes(app, {
    projects, features,
    workItems,
    tmuxClient: {} as any,
    paneRuntimes: {} as any,
    broadcast: () => {},
    sse
  } as any);
  return { app, features, workItems, featureId, emitted };
}

test("POST /api/features/:id/canvas/bind {canvasId:'xyz'} sets canvas_id", async () => {
  const { app, workItems, featureId } = setup();
  const res = await app.request(`/api/features/${featureId}/canvas/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: "canvas_xyz" })
  });
  expect(res.status).toBe(200);
  expect(workItems.getByFeature(featureId)!.canvasId).toBe("canvas_xyz");
});

test("POST /api/features/:id/canvas/bind {canvasId:null} clears canvas_id", async () => {
  const { app, workItems, featureId } = setup();
  workItems.setCanvasIdForFeature(featureId, "canvas_abc");
  const res = await app.request(`/api/features/${featureId}/canvas/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: null })
  });
  expect(res.status).toBe(200);
  expect(workItems.getByFeature(featureId)!.canvasId).toBeNull();
});

test("POST /api/features/:id/canvas/bind emits workItemUpdated SSE", async () => {
  const { app, featureId, emitted } = setup();
  await app.request(`/api/features/${featureId}/canvas/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: "canvas_abc" })
  });
  const updateEvent = emitted.find((e) => e.event === "workItemUpdated");
  expect(updateEvent).toBeDefined();
  expect(updateEvent!.data.item.canvasId).toBe("canvas_abc");
});

test("POST /api/features/:id/canvas/bind on missing feature returns 404", async () => {
  const { app } = setup();
  const res = await app.request(`/api/features/feat_bogus/canvas/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: "x" })
  });
  expect(res.status).toBe(404);
});

test("POST /api/features/:id/canvas/bind invalid body returns 400", async () => {
  const { app, featureId } = setup();
  const res = await app.request(`/api/features/${featureId}/canvas/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: 42 })
  });
  expect(res.status).toBe(400);
});
