import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";

function newDb(): Database {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  return db;
}

test("schema: work_items has canvas_id column (text, nullable)", () => {
  const db = newDb();
  const cols = db.prepare("pragma table_info(work_items)").all() as Array<{ name: string; type: string; notnull: number }>;
  const col = cols.find((c) => c.name === "canvas_id");
  expect(col).toBeDefined();
  expect(col!.type.toLowerCase()).toBe("text");
  expect(col!.notnull).toBe(0);
});

test("schema: work_items has summary column (text, nullable)", () => {
  const db = newDb();
  const cols = db.prepare("pragma table_info(work_items)").all() as Array<{ name: string; type: string; notnull: number }>;
  const col = cols.find((c) => c.name === "summary");
  expect(col).toBeDefined();
  expect(col!.type.toLowerCase()).toBe("text");
  expect(col!.notnull).toBe(0);
});

test("schema: body column is dropped", () => {
  const db = newDb();
  const cols = db.prepare("pragma table_info(work_items)").all() as Array<{ name: string }>;
  expect(cols.find((c) => c.name === "body")).toBeUndefined();
});

import { WorkItemStore, WORK_ITEM_SUMMARY_MAX_CHARS } from "../src/server/modules/agent/work-item-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";

function setup() {
  const db = newDb();
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", gitRemote: null, isGit: false
  });
  const featureId = features.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  return { db, projects, features, workItems, projectId, featureId };
}

test("store: WorkItem exposes summary + canvasId (defaults null)", () => {
  const { workItems, featureId } = setup();
  const item = workItems.getByFeature(featureId)!;
  expect(item.summary).toBeNull();
  expect(item.canvasId).toBeNull();
});

test("store: update sets summary, truncates to the summary cap", () => {
  const { workItems, featureId } = setup();
  const item = workItems.getByFeature(featureId)!;
  const longText = "a".repeat(WORK_ITEM_SUMMARY_MAX_CHARS + 200);
  const next = workItems.update(item.id, { summary: longText });
  expect(next!.summary).toHaveLength(WORK_ITEM_SUMMARY_MAX_CHARS);
});

test("store: update sets summary to null", () => {
  const { workItems, featureId } = setup();
  const item = workItems.getByFeature(featureId)!;
  workItems.update(item.id, { summary: "hello" });
  expect(workItems.getByFeature(featureId)!.summary).toBe("hello");
  workItems.update(item.id, { summary: null });
  expect(workItems.getByFeature(featureId)!.summary).toBeNull();
});

test("store: update sets canvasId", () => {
  const { workItems, featureId } = setup();
  const item = workItems.getByFeature(featureId)!;
  const next = workItems.update(item.id, { canvasId: "canvas_abc" });
  expect(next!.canvasId).toBe("canvas_abc");
});

test("store: setCanvasIdForFeature succeeds and returns true", () => {
  const { workItems, featureId } = setup();
  expect(workItems.setCanvasIdForFeature(featureId, "canvas_abc")).toBe(true);
  expect(workItems.getByFeature(featureId)!.canvasId).toBe("canvas_abc");
});

test("store: setCanvasIdForFeature on missing feature returns false", () => {
  const { workItems } = setup();
  expect(workItems.setCanvasIdForFeature("feat_nonexistent", "canvas_abc")).toBe(false);
});

test("store: setCanvasIdForFeature(null) clears binding", () => {
  const { workItems, featureId } = setup();
  workItems.setCanvasIdForFeature(featureId, "canvas_abc");
  workItems.setCanvasIdForFeature(featureId, null);
  expect(workItems.getByFeature(featureId)!.canvasId).toBeNull();
});

test("store: setCanvasIdForFeature bumps last_activity_at", async () => {
  const { workItems, featureId } = setup();
  const before = workItems.getByFeature(featureId)!;
  await new Promise((r) => setTimeout(r, 5));
  workItems.setCanvasIdForFeature(featureId, "canvas_xyz");
  const after = workItems.getByFeature(featureId)!;
  expect(after.lastActivityAt > before.lastActivityAt).toBe(true);
});
