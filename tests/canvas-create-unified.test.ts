import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { initializeCanvasSchema } from "../src/server/modules/canvas/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { buildCanvasToolPacks } from "../src/server/modules/canvas/tool-packs.js";
import type { ToolDefinition } from "../src/server/modules/agent/tool-registry.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  initializeCanvasSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const canvases = new CanvasStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", gitRemote: null, isGit: false
  });
  const featureId = features.insert({
    projectId, name: "feat-x", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "feat-x", ownership: "app"
  });
  const emitted: Array<{ event: string; data: any }> = [];
  const sse = { emit: (event: string, data: any) => emitted.push({ event, data }) } as any;
  return { db, projects, features, workItems, canvases, projectId, featureId, sse, emitted };
}

function pickTool(packs: any[], name: string): ToolDefinition<any, any> | undefined {
  for (const pack of packs) {
    for (const t of pack.tools) if (t.name === name) return t;
  }
  return undefined;
}

test("canvas_create feature schema accepts title/bindToFeature and rejects projectId", () => {
  const { canvases, sse, workItems } = setup();
  const packs = buildCanvasToolPacks({ scope: "worker", canvasStore: canvases, sse, workStore: workItems });
  const tool = pickTool(packs, "canvas_create")!;
  expect(tool).toBeDefined();
  expect(tool.parameters.parse({ title: "hello" })).toMatchObject({ title: "hello" });
  expect(tool.parameters.parse({ title: "hello", bindToFeature: true })).toMatchObject({ bindToFeature: true });
  expect(() => tool.parameters.parse({ title: "hello", projectId: "p" })).toThrow();
  // kind param was removed when the structured format was retired — only html canvases now
  expect(() => tool.parameters.parse({ title: "hello", kind: "html" })).toThrow();
});

test("canvas_create overview schema accepts projectId and rejects feature binding", () => {
  const { canvases, sse, workItems } = setup();
  const packs = buildCanvasToolPacks({ scope: "manager", canvasStore: canvases, sse, workStore: workItems });
  const tool = pickTool(packs, "canvas_create")!;
  expect(tool.parameters.parse({ title: "hello", projectId: "p" })).toMatchObject({ projectId: "p" });
  expect(() => tool.parameters.parse({ title: "hello", bindToFeature: true })).toThrow();
});

test("canvas_create always produces html canvases", async () => {
  const { canvases, sse, workItems, featureId, projectId } = setup();
  const packs = buildCanvasToolPacks({ scope: "worker", canvasStore: canvases, sse, workStore: workItems });
  const tool = pickTool(packs, "canvas_create")!;
  const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;
  const result = await tool.handler({ title: "test" }, ctx) as any;
  expect(result.kind).toBe("html");
});

test("canvas_create bindToFeature=true on feature scope sets work_items.canvas_id", async () => {
  const { canvases, sse, workItems, featureId, projectId } = setup();
  const packs = buildCanvasToolPacks({ scope: "worker", canvasStore: canvases, sse, workStore: workItems });
  const tool = pickTool(packs, "canvas_create")!;
  const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;
  expect(workItems.getByFeature(featureId)!.canvasId).toBeNull();
  const result = await tool.handler({ title: "test", bindToFeature: true }, ctx) as any;
  expect(result.canvasId).toBeTruthy();
  expect(workItems.getByFeature(featureId)!.canvasId).toBe(result.canvasId);
});

test("canvas_create bindToFeature=true called twice → canvas_id overwrites to newest", async () => {
  const { canvases, sse, workItems, featureId, projectId } = setup();
  const packs = buildCanvasToolPacks({ scope: "worker", canvasStore: canvases, sse, workStore: workItems });
  const tool = pickTool(packs, "canvas_create")!;
  const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;
  const a = await tool.handler({ title: "first", bindToFeature: true }, ctx) as any;
  const b = await tool.handler({ title: "second", bindToFeature: true }, ctx) as any;
  expect(workItems.getByFeature(featureId)!.canvasId).toBe(b.canvasId);
  expect(b.canvasId).not.toBe(a.canvasId);
});

test("canvas_create bindToFeature=false (default) does NOT touch work_items.canvas_id", async () => {
  const { canvases, sse, workItems, featureId, projectId } = setup();
  const packs = buildCanvasToolPacks({ scope: "worker", canvasStore: canvases, sse, workStore: workItems });
  const tool = pickTool(packs, "canvas_create")!;
  const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;
  await tool.handler({ title: "first" }, ctx);
  expect(workItems.getByFeature(featureId)!.canvasId).toBeNull();
});

test("canvas_create bindToFeature=true on overview scope is ignored with warning", async () => {
  const { canvases, sse, workItems } = setup();
  const packs = buildCanvasToolPacks({ scope: "manager", canvasStore: canvases, sse, workStore: workItems });
  const tool = pickTool(packs, "canvas_create")!;
  const ctx = { threadId: "t-1", scope: { kind: "manager" } } as any;
  const result = await tool.handler({ title: "test", bindToFeature: true, projectId: "p" }, ctx) as any;
  expect(result.canvasId).toBeTruthy();
  expect(result.warning).toMatch(/bindToFeature/i);
});

test("canvas_create bindToFeature=true on feature missing work_item creates canvas + warning, no crash", async () => {
  const { db, canvases, sse, workItems, featureId, projectId } = setup();
  // Simulate a corrupted feature row: delete the auto-created work_item.
  db.prepare("delete from work_items where feature_id = ?").run(featureId);
  const packs = buildCanvasToolPacks({ scope: "worker", canvasStore: canvases, sse, workStore: workItems });
  const tool = pickTool(packs, "canvas_create")!;
  const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;
  const result = await tool.handler({ title: "test", bindToFeature: true }, ctx) as any;
  expect(result.canvasId).toBeTruthy();
  expect(result.warning).toMatch(/no work_item|not bound/i);
});

test("canvas_create bindToFeature=true emits workItemUpdated SSE with new canvasId", async () => {
  const { canvases, sse, workItems, featureId, projectId, emitted } = setup();
  const packs = buildCanvasToolPacks({
    scope: "worker", canvasStore: canvases, sse, workStore: workItems
  });
  const tool = pickTool(packs, "canvas_create")!;
  const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;
  const result = await tool.handler({ title: "test", bindToFeature: true }, ctx) as any;
  const updateEvent = emitted.find((e) => e.event === "workItemUpdated");
  expect(updateEvent).toBeDefined();
  expect(updateEvent!.data.item.canvasId).toBe(result.canvasId);
});

test("canvas_create bindToFeature=false does NOT emit workItemUpdated SSE", async () => {
  const { canvases, sse, workItems, featureId, projectId, emitted } = setup();
  const packs = buildCanvasToolPacks({
    scope: "worker", canvasStore: canvases, sse, workStore: workItems
  });
  const tool = pickTool(packs, "canvas_create")!;
  const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;
  await tool.handler({ title: "test" }, ctx);
  const updateEvent = emitted.find((e) => e.event === "workItemUpdated");
  expect(updateEvent).toBeUndefined();
});
