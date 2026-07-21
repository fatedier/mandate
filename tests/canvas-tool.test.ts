import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { buildCanvasToolPacks } from "../src/server/modules/canvas/tool-packs.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

class CapturingSse {
  events: Array<{ name: string; data: any }> = [];
  emit(name: string, data: any) {
    this.events.push({ name, data });
  }
}

test("canvas_create stores a feature-scoped canvas without opening it", async () => {
  const { dir, store, projects, features, agentStore, cleanup } = freshStoresEnv("md-canvas-tool-");
  try {
    const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
    const featureId = seedFeature(features, projectId, { name: "F", tmuxWindowName: "f" });
    const project = projects.getById(projectId)!;
    const feature = features.getById(featureId)!;
    const thread = agentStore.getOrCreateThread("worker", featureId);
    const canvasStore = new CanvasStore(store.db, dir);
    const sse = new CapturingSse();

    const pack = buildCanvasToolPacks({
      scope: "worker",
      canvasStore,
      sse: sse as any
    })[0];
    const create = pack.tools.find((tool) => tool.name === "canvas_create")!;
    const result = await create.handler(
      {
        title: "Implementation plan"
      },
      {
        threadId: thread.id,
        wakeId: "wake",
        scope: {
          kind: "worker",
          feature: { workingDir: feature.worktreePath },
          project: { workingDir: project.workingDir }
        },
        feature,
        project
      }
    );

    expect(result).toMatchObject({
      ok: true,
      title: "Implementation plan",
      kind: "html",
      path: expect.stringMatching(/^\/canvas\//)
    });
    if (!("ok" in result)) throw new Error("expected ok result");
    const canvas = canvasStore.getById(result.canvasId)!;
    expect(canvas.scope).toBe("worker");
    expect(canvas.scopeId).toBe(featureId);
    expect(canvas.projectId).toBe(projectId);
    expect(canvas.threadId).toBe(thread.id);
    expect(canvas.kind).toBe("html");
    expect((result as any).sourcePath).toBe(canvas.filePath);
    expect((result as any).sourcePath).toContain(path.join("resources", "projects", projectId, "canvases"));
    expect(fs.existsSync(path.dirname(canvas.filePath!))).toBe(true);
    expect(fs.existsSync(canvas.filePath!)).toBe(false);
    expect(canvas.html).toBe("");
    expect(sse.events).toEqual([
      { name: "canvasUpdated", data: { canvasId: canvas.id, featureId } }
    ]);
  } finally {
    cleanup();
  }
});


test("canvas_create rejects inline HTML parameters", () => {
  const { dir, store, cleanup } = freshStoresEnv("md-canvas-tool-schema-");
  try {
    const canvasStore = new CanvasStore(store.db, dir);
    const pack = buildCanvasToolPacks({
      scope: "manager",
      canvasStore,
      sse: new CapturingSse() as any
    })[0];
    const create = pack.tools.find((tool) => tool.name === "canvas_create")!;
    expect(create.parameters.safeParse({
      title: "Implementation plan",
      html: "<h1>Plan</h1>"
    }).success).toBe(false);
  } finally {
    cleanup();
  }
});

test("manager-created canvases notify lists without claiming a Worker owner", async () => {
  const { dir, store, projects, agentStore, cleanup } = freshStoresEnv("md-canvas-create-manager-");
  try {
    const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
    const thread = agentStore.getOrCreateThread("manager", null);
    const sse = new CapturingSse();
    const create = buildCanvasToolPacks({
      scope: "manager", canvasStore: new CanvasStore(store.db, dir), sse: sse as any
    })[0]!.tools.find((tool) => tool.name === "canvas_create")!;
    for (const owner of [undefined, projectId]) {
      const result = await create.handler({ title: "Manager artifact", ...(owner ? { projectId: owner } : {}) }, {
        threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }
      });
      expect(result).toMatchObject({ ok: true });
      if (!("ok" in result)) throw new Error("expected a created canvas");
      expect(sse.events.at(-1)).toEqual({ name: "canvasUpdated", data: { canvasId: result.canvasId, featureId: null } });
    }
    expect(sse.events).toHaveLength(2);
  } finally { cleanup(); }
});

test("canvas_create description sets artifact quality bar", () => {
  const { dir, store, cleanup } = freshStoresEnv("md-canvas-tool-description-");
  try {
    const canvasStore = new CanvasStore(store.db, dir);
    const pack = buildCanvasToolPacks({
      scope: "manager",
      canvasStore,
      sse: new CapturingSse() as any
    })[0];
    const create = pack.tools.find((tool) => tool.name === "canvas_create")!;
    expect(create.description).toContain("shipped product surface");
    expect(create.description).toContain("Linear, Vercel, Stripe");
    expect(create.description).toContain("fake controls");
  } finally {
    cleanup();
  }
});

test("canvas_open navigates to an existing canvas", async () => {
  const { dir, store, agentStore, cleanup } = freshStoresEnv("md-canvas-open-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const canvasStore = new CanvasStore(store.db, dir);
    const canvas = canvasStore.create({
      title: "Plan",
      scope: "manager",
      scopeId: null,
      threadId: thread.id
    });
    const sse = new CapturingSse();
    const pack = buildCanvasToolPacks({
      scope: "manager",
      canvasStore,
      sse: sse as any
    })[0];
    const open = pack.tools.find((tool) => tool.name === "canvas_open")!;

    const result = await open.handler(
      { canvasId: canvas.id },
      {
        threadId: thread.id,
        wakeId: "wake",
        scope: {
          kind: "manager",
          managerDir: "/tmp",
          projectWorkingDirs: []
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      canvasId: canvas.id,
      path: expect.stringMatching(/^\/canvas\//)
    });
    expect((result as any).title).toBeUndefined();
    if (!("ok" in result)) throw new Error("expected ok result");
    expect(sse.events).toEqual([
      {
        name: "agentUiAction",
        data: {
          action: "navigate",
          payload: { path: result.path }
        }
      }
    ]);
  } finally {
    cleanup();
  }
});

test("canvas_read returns metadata and sourcePath only", async () => {
  const { dir, store, agentStore, cleanup } = freshStoresEnv("md-canvas-read-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const canvasStore = new CanvasStore(store.db, dir);
    const canvas = canvasStore.create({
      title: "Plan",
      scope: "manager",
      scopeId: null,
      threadId: thread.id
    });
    const pack = buildCanvasToolPacks({
      scope: "manager",
      canvasStore,
      sse: new CapturingSse() as any
    })[0];
    const read = pack.tools.find((tool) => tool.name === "canvas_read")!;

    const metadataOnly = await read.handler(
      { canvasId: canvas.id },
      { threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } }
    );
    expect(metadataOnly).toMatchObject({
      canvasId: canvas.id,
      title: "Plan",
      kind: "html",
      publishedHtmlLength: 0
    });
    expect((metadataOnly as any).sourcePath).toContain(path.join("resources", "global", "canvases"));
    expect((metadataOnly as any).html).toBeUndefined();
    expect(read.parameters.safeParse({ canvasId: canvas.id, includeHtml: true }).success).toBe(false);
  } finally {
    cleanup();
  }
});

test("canvas_read lets overview inspect feature canvases from other threads", async () => {
  const { dir, store, projects, features, agentStore, cleanup } = freshStoresEnv("md-canvas-read-overview-");
  try {
    const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
    const featureId = seedFeature(features, projectId, { name: "F", tmuxWindowName: "f" });
    const featureThread = agentStore.getOrCreateThread("worker", featureId);
    const overviewThread = agentStore.getOrCreateThread("manager", null);
    const canvasStore = new CanvasStore(store.db, dir);
    const canvas = canvasStore.create({
      title: "Feature dashboard",
      scope: "worker",
      scopeId: featureId,
      threadId: featureThread.id,
      projectId
    });
    const pack = buildCanvasToolPacks({
      scope: "manager",
      agentStore,
      canvasStore,
      sse: new CapturingSse() as any
    })[0];
    const read = pack.tools.find((tool) => tool.name === "canvas_read")!;

    const result = await read.handler(
      { canvasId: canvas.id },
      {
        threadId: overviewThread.id,
        wakeId: "wake",
        scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }
      }
    );

    expect(result).toMatchObject({
      canvasId: canvas.id,
      title: "Feature dashboard",
      kind: "html"
    });
    expect((result as any).sourcePath).toBe(canvas.filePath);
    expect((result as any).html).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("canvas_read lets feature agents inspect their feature canvases but not other features", async () => {
  const { dir, store, projects, features, agentStore, cleanup } = freshStoresEnv("md-canvas-read-feature-");
  try {
    const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
    const featureId = seedFeature(features, projectId, { name: "F", tmuxWindowName: "f" });
    const otherFeatureId = seedFeature(features, projectId, { name: "Other", tmuxWindowName: "other" });
    const project = projects.getById(projectId)!;
    const feature = features.getById(featureId)!;
    const otherFeature = features.getById(otherFeatureId)!;
    const ownerThread = agentStore.getOrCreateThread("worker", featureId);
    const otherThread = agentStore.getOrCreateThread("worker", otherFeatureId);
    const canvasStore = new CanvasStore(store.db, dir);
    const canvas = canvasStore.create({
      title: "Feature dashboard",
      scope: "worker",
      scopeId: featureId,
      threadId: ownerThread.id,
      projectId
    });
    const pack = buildCanvasToolPacks({
      scope: "worker",
      agentStore,
      canvasStore,
      sse: new CapturingSse() as any
    })[0];
    const read = pack.tools.find((tool) => tool.name === "canvas_read")!;

    const sameFeatureResult = await read.handler(
      { canvasId: canvas.id },
      {
        threadId: ownerThread.id,
        wakeId: "wake",
        scope: {
          kind: "worker",
          feature: { workingDir: feature.worktreePath },
          project: { workingDir: project.workingDir }
        },
        feature,
        project
      }
    );
    expect(sameFeatureResult).toMatchObject({ canvasId: canvas.id });

    const otherFeatureResult = await read.handler(
      { canvasId: canvas.id },
      {
        threadId: otherThread.id,
        wakeId: "wake",
        scope: {
          kind: "worker",
          feature: { workingDir: otherFeature.worktreePath },
          project: { workingDir: project.workingDir }
        },
        feature: otherFeature,
        project
      }
    );
    expect(otherFeatureResult).toEqual({ error: "canvas is not visible from this agent scope" });
  } finally {
    cleanup();
  }
});

test("canvas_update renames only and rejects inline HTML parameters", async () => {
  const { dir, store, agentStore, cleanup } = freshStoresEnv("md-canvas-update-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const canvasStore = new CanvasStore(store.db, dir);
    const canvas = canvasStore.create({
      title: "Plan",
      scope: "manager",
      scopeId: null,
      threadId: thread.id
    });
    fs.writeFileSync(canvas.filePath!, "<h1>Plan</h1>", "utf8");
    canvasStore.publishSource(canvas.id);

    const sse = new CapturingSse();
    const pack = buildCanvasToolPacks({
      scope: "manager",
      canvasStore,
      sse: sse as any
    })[0];
    const update = pack.tools.find((tool) => tool.name === "canvas_update")!;
    expect(update.parameters.safeParse({
      canvasId: canvas.id,
      title: "Renamed",
      html: "<h1>Changed</h1>"
    }).success).toBe(false);

    const result = await update.handler(
      { canvasId: canvas.id, title: "Renamed" },
      { threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } }
    );

    expect(result).toMatchObject({ ok: true, canvasId: canvas.id, title: "Renamed" });
    expect(canvasStore.getById(canvas.id)?.title).toBe("Renamed");
    expect(canvasStore.getById(canvas.id)?.html).toBe("<h1>Plan</h1>");
    expect(fs.readFileSync(canvas.filePath!, "utf8")).toBe("<h1>Plan</h1>");
    expect(sse.events).toEqual([
      {
        name: "canvasUpdated",
        data: { canvasId: canvas.id, featureId: null }
      }
    ]);
  } finally {
    cleanup();
  }
});

test("feature thread can update and publish same-feature canvases it did not create", async () => {
  const { dir, store, projects, features, agentStore, cleanup } = freshStoresEnv("md-canvas-feature-edit-");
  try {
    const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
    const featureId = seedFeature(features, projectId, { name: "F", tmuxWindowName: "f" });
    const project = projects.getById(projectId)!;
    const feature = features.getById(featureId)!;
    const ownerThread = agentStore.getOrCreateThread("manager", null);
    const featureThread = agentStore.getOrCreateThread("worker", featureId);
    const canvasStore = new CanvasStore(store.db, dir);
    const canvas = canvasStore.create({
      title: "Draft dashboard",
      scope: "worker",
      scopeId: featureId,
      threadId: ownerThread.id,
      projectId
    });
    fs.writeFileSync(canvas.filePath!, "<h1>Published by main thread</h1>", "utf8");
    const sse = new CapturingSse();
    const pack = buildCanvasToolPacks({
      scope: "worker",
      agentStore,
      canvasStore,
      sse: sse as any
    })[0];
    const update = pack.tools.find((tool) => tool.name === "canvas_update")!;
    const publish = pack.tools.find((tool) => tool.name === "canvas_publish")!;
    const ctx = {
      threadId: featureThread.id,
      wakeId: "wake",
      scope: {
        kind: "worker" as const,
        feature: { workingDir: feature.worktreePath },
        project: { workingDir: project.workingDir }
      },
      feature,
      project
    };

    const updateResult = await update.handler({ canvasId: canvas.id, title: "Final dashboard" }, ctx);
    expect(updateResult).toMatchObject({
      ok: true,
      canvasId: canvas.id,
      title: "Final dashboard"
    });
    const publishResult = await publish.handler({ canvasId: canvas.id }, ctx);
    expect(publishResult).toMatchObject({
      ok: true,
      canvasId: canvas.id
    });

    const updated = canvasStore.getById(canvas.id)!;
    expect(updated.title).toBe("Final dashboard");
    expect(updated.html).toBe("<h1>Published by main thread</h1>");
    expect(sse.events).toEqual([
      { name: "canvasUpdated", data: { canvasId: canvas.id, featureId } },
      { name: "canvasUpdated", data: { canvasId: canvas.id, featureId } }
    ]);
  } finally {
    cleanup();
  }
});

test("other feature threads cannot update a feature canvas", async () => {
  const { dir, store, projects, features, agentStore, cleanup } = freshStoresEnv("md-canvas-feature-edit-deny-");
  try {
    const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
    const featureId = seedFeature(features, projectId, { name: "F", tmuxWindowName: "f" });
    const otherFeatureId = seedFeature(features, projectId, { name: "Other", tmuxWindowName: "other" });
    const project = projects.getById(projectId)!;
    const otherFeature = features.getById(otherFeatureId)!;
    const ownerThread = agentStore.getOrCreateThread("worker", featureId);
    const otherThread = agentStore.getOrCreateThread("worker", otherFeatureId);
    const canvasStore = new CanvasStore(store.db, dir);
    const canvas = canvasStore.create({
      title: "Main dashboard",
      scope: "worker",
      scopeId: featureId,
      threadId: ownerThread.id,
      projectId
    });
    const pack = buildCanvasToolPacks({
      scope: "worker",
      agentStore,
      canvasStore,
      sse: new CapturingSse() as any
    })[0];
    const update = pack.tools.find((tool) => tool.name === "canvas_update")!;

    const result = await update.handler(
      { canvasId: canvas.id, title: "Other feature edit" },
      {
        threadId: otherThread.id,
        wakeId: "wake",
        scope: {
          kind: "worker",
          feature: { workingDir: otherFeature.worktreePath },
          project: { workingDir: project.workingDir }
        },
        feature: otherFeature,
        project
      }
    );

    expect(result).toEqual({ error: "canvas is not editable from this agent scope" });
    expect(canvasStore.getById(canvas.id)?.title).toBe("Main dashboard");
  } finally {
    cleanup();
  }
});

test("canvas_publish refreshes html from the editable source file", async () => {
  const { dir, store, agentStore, cleanup } = freshStoresEnv("md-canvas-publish-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const canvasStore = new CanvasStore(store.db, dir);
    const canvas = canvasStore.create({
      title: "Plan",
      scope: "manager",
      scopeId: null,
      threadId: thread.id
    });
    fs.writeFileSync(canvas.filePath!, "<h1>Edited</h1>", "utf8");

    const sse = new CapturingSse();
    const pack = buildCanvasToolPacks({
      scope: "manager",
      canvasStore,
      sse: sse as any
    })[0];
    const publish = pack.tools.find((tool) => tool.name === "canvas_publish")!;

    const result = await publish.handler(
      { canvasId: canvas.id },
      { threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } }
    );

    expect(result).toMatchObject({
      ok: true,
      canvasId: canvas.id,
      path: `/canvas/${canvas.id}`
    });
    expect((result as any).sourcePath).toBeUndefined();
    expect(canvasStore.getById(canvas.id)?.html).toBe("<h1>Edited</h1>");
    expect(sse.events).toEqual([
      {
        name: "canvasUpdated",
        data: { canvasId: canvas.id, featureId: null }
      }
    ]);
  } finally {
    cleanup();
  }
});
