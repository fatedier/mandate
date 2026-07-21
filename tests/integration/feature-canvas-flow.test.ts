import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../../src/server/modules/agent/schema.js";
import { initializeCanvasSchema } from "../../src/server/modules/canvas/schema.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import { CanvasStore } from "../../src/server/modules/canvas/canvas-store.js";
import { buildCanvasToolPacks } from "../../src/server/modules/canvas/tool-packs.js";

function setupServer() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  initializeCanvasSchema(db);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-canvas-e2e-"));
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const canvases = new CanvasStore(db, dataDir);
  const cleanup = () => fs.rmSync(dataDir, { recursive: true, force: true });
  return { db, projects, features, workItems, canvases, cleanup };
}

function pickCanvasCreate(packs: any[]) {
  for (const pack of packs) {
    for (const t of pack.tools) if (t.name === "canvas_create") return t;
  }
  return undefined;
}

test("E2E: feature canvas binding happy path", async () => {
  const { projects, features, workItems, canvases, cleanup } = setupServer();
  try {
    const projectId = projects.insert({
      name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
      ownership: "app", gitRemote: null, isGit: false
    });
    const featureId = features.insert({
      projectId, name: "feat-x", mode: "shared-cwd", branch: null, baseRef: null,
      worktreePath: null, tmuxWindowName: "feat-x", ownership: "app"
    });

    expect(workItems.getByFeature(featureId)!.canvasId).toBeNull();

    const emitted: Array<{ event: string; data: any }> = [];
    const sse = { emit: (event: string, data: any) => emitted.push({ event, data }) } as any;
    const packs = buildCanvasToolPacks({
      scope: "worker", canvasStore: canvases, sse, workStore: workItems
    });
    const tool = pickCanvasCreate(packs)!;
    const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;

    const result = await tool.handler({ title: "Feature dashboard", bindToFeature: true }, ctx) as any;
    expect(result.canvasId).toBeTruthy();
    expect(result.kind).toBe("html");
    expect(workItems.getByFeature(featureId)!.canvasId).toBe(result.canvasId);

    const updateEvent = emitted.find((e) => e.event === "workItemUpdated");
    expect(updateEvent).toBeDefined();
    expect(updateEvent!.data.item.canvasId).toBe(result.canvasId);
  } finally {
    cleanup();
  }
});

test("E2E: feature missing work_item — canvas created but unbound + warning", async () => {
  const { db, projects, features, workItems, canvases, cleanup } = setupServer();
  try {
    const projectId = projects.insert({
      name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
      ownership: "app", gitRemote: null, isGit: false
    });
    const featureId = features.insert({
      projectId, name: "old", mode: "shared-cwd", branch: null, baseRef: null,
      worktreePath: null, tmuxWindowName: "old", ownership: "app"
    });
    // Simulate a corrupted feature row: delete auto-created work_item.
    db.prepare("delete from work_items where feature_id = ?").run(featureId);

    const sse = { emit: () => {} } as any;
    const packs = buildCanvasToolPacks({
      scope: "worker", canvasStore: canvases, sse, workStore: workItems
    });
    const tool = pickCanvasCreate(packs)!;
    const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;
    const result = await tool.handler({ title: "test", bindToFeature: true }, ctx) as any;
    expect(result.canvasId).toBeTruthy();
    expect(result.warning).toMatch(/no work_item|not bound/i);
  } finally {
    cleanup();
  }
});

test("E2E: multi-bind — last canvas wins, first canvas survives unbound", async () => {
  const { db, projects, features, workItems, canvases, cleanup } = setupServer();
  try {
    const projectId = projects.insert({
      name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
      ownership: "app", gitRemote: null, isGit: false
    });
    const featureId = features.insert({
      projectId, name: "feat-x", mode: "shared-cwd", branch: null, baseRef: null,
      worktreePath: null, tmuxWindowName: "feat-x", ownership: "app"
    });
    const sse = { emit: () => {} } as any;
    const packs = buildCanvasToolPacks({
      scope: "worker", canvasStore: canvases, sse, workStore: workItems
    });
    const tool = pickCanvasCreate(packs)!;
    const ctx = { threadId: "t-1", scope: { kind: "worker" }, feature: { id: featureId }, project: { id: projectId } } as any;

    const a = await tool.handler({ title: "first", bindToFeature: true }, ctx) as any;
    const b = await tool.handler({ title: "second", bindToFeature: true }, ctx) as any;
    expect(b.canvasId).not.toBe(a.canvasId);
    expect(workItems.getByFeature(featureId)!.canvasId).toBe(b.canvasId);
    // First canvas still exists
    expect(db.prepare("select 1 from canvas_documents where id = ?").get(a.canvasId)).not.toBeNull();
  } finally {
    cleanup();
  }
});
