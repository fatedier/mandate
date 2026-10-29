import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { buildCanvasToolPacks } from "../src/server/modules/canvas/tool-packs.js";
import { canvasCreateDescription } from "../src/server/modules/canvas/canvas-contract.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { CLEAN_REPORT } from "./helpers/canvas-pages.js";
import { stub, toolContext } from "./helpers/typed.js";

type CanvasResult = { ok: true; canvasId: string; path: string; title?: string; sourcePath?: string } | { error: string };

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
      sse: stub<AgentSseEmitter>(sse)
    })[0];
    const create = pack.tools.find((tool) => tool.name === "canvas_create")!;
    const result = (await create.handler(
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
    )) as CanvasResult;

    expect(result).toMatchObject({
      ok: true,
      title: "Implementation plan",
      kind: "report",
      path: expect.stringMatching(/^\/canvas\//)
    });
    if (!("ok" in result)) throw new Error("expected ok result");
    // A link to it, ready for a reply: its title, then its path.
    expect((result as { link?: string }).link).toBe(`[Implementation plan](/canvas/${result.canvasId})`);
    const canvas = canvasStore.getById(result.canvasId)!;
    expect(canvas.scope).toBe("worker");
    expect(canvas.scopeId).toBe(featureId);
    expect(canvas.projectId).toBe(projectId);
    expect(canvas.threadId).toBe(thread.id);
    expect(canvas.kind).toBe("report");
    expect(result.sourcePath).toBe(canvas.filePath!);
    expect(result.sourcePath).toContain(path.join("resources", "projects", projectId, "canvases"));
    expect(fs.existsSync(path.dirname(canvas.filePath!))).toBe(true);
    expect(fs.existsSync(canvas.filePath!)).toBe(false);
    expect(canvas.html).toBe("");
    expect(sse.events).toStrictEqual([
      { name: "canvasUpdated", data: { canvasId: canvas.id, featureId } }
    ]);
  } finally {
    cleanup();
  }
});


/** canvas_create as the scope's agent gets it, for checks of its schema. */
function withCreateTool(scope: "manager" | "worker", check: (create: ToolDefinition<any, any>) => void): void {
  const { dir, store } = freshStoresEnv("md-canvas-tool-schema-");
  const packs = buildCanvasToolPacks({ scope, canvasStore: new CanvasStore(store.db, dir), sse: stub<AgentSseEmitter>(new CapturingSse()) });
  const create = packs.flatMap((pack) => pack.tools).find((tool) => tool.name === "canvas_create");
  expect(create).toBeDefined();
  check(create!);
}

test("canvas_create feature schema accepts a title and rejects projectId and feature binding", () => {
  withCreateTool("worker", (tool) => {
    expect(tool.parameters.parse({ title: "hello" })).toMatchObject({ title: "hello" });
    // Binding a dashboard to the feature was retired with the feature plan.
    expect(() => tool.parameters.parse({ title: "hello", bindToFeature: true })).toThrow();
    expect(() => tool.parameters.parse({ title: "hello", projectId: "p" })).toThrow();
    // kind is report or design; html is not a kind.
    expect(() => tool.parameters.parse({ title: "hello", kind: "html" })).toThrow();
  });
});

test("canvas_create overview schema accepts projectId and kind report or design, and rejects inline HTML, feature binding and any other kind", () => {
  withCreateTool("manager", (tool) => {
    expect(tool.parameters.parse({ title: "hello", projectId: "p" })).toMatchObject({ projectId: "p" });
    expect(() => tool.parameters.parse({ title: "hello", bindToFeature: true })).toThrow();
    expect(tool.parameters.safeParse({ title: "Implementation plan", html: "<h1>Plan</h1>" }).success).toBe(false);
    expect(tool.parameters.safeParse({ title: "Draft", kind: "design" }).success).toBe(true);
    expect(tool.parameters.safeParse({ title: "Draft", kind: "report" }).success).toBe(true);
    expect(tool.parameters.safeParse({ title: "Draft", kind: "html" }).success).toBe(false);
  });
});

test("manager-created canvases notify lists without claiming a Worker owner", async () => {
  const { dir, store, projects, agentStore } = freshStoresEnv("md-canvas-create-manager-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const thread = agentStore.getOrCreateThread("manager", null);
  const sse = new CapturingSse();
  const create = buildCanvasToolPacks({
    scope: "manager", canvasStore: new CanvasStore(store.db, dir), sse: stub<AgentSseEmitter>(sse)
  })[0]!.tools.find((tool) => tool.name === "canvas_create")!;
  for (const owner of [undefined, projectId]) {
    const result = (await create.handler({ title: "Manager artifact", ...(owner ? { projectId: owner } : {}) }, {
      threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }
    })) as CanvasResult;
    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result)) throw new Error("expected a created canvas");
    expect(sse.events.at(-1)).toEqual({ name: "canvasUpdated", data: { canvasId: result.canvasId, featureId: null } });
  }
  expect(sse.events).toHaveLength(2);
});

test("canvas_create's description is the page contract for its scope", () => {
  const { dir, store } = freshStoresEnv("md-canvas-tool-description-");
  const canvasStore = new CanvasStore(store.db, dir);
  for (const scope of ["manager", "worker"] as const) {
    const pack = buildCanvasToolPacks({ scope, canvasStore, sse: stub<AgentSseEmitter>(new CapturingSse()) })[0];
    const create = pack.tools.find((tool) => tool.name === "canvas_create")!;
    expect(create.description).toBe(canvasCreateDescription(scope === "worker"));
  }
});

test("canvas_read returns metadata and sourcePath only", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-read-");
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
    sse: stub<AgentSseEmitter>(new CapturingSse())
  })[0];
  const read = pack.tools.find((tool) => tool.name === "canvas_read")!;

  const metadataOnly = await read.handler(
    { canvasId: canvas.id },
    { threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } }
  );
  expect(metadataOnly).toMatchObject({
    canvasId: canvas.id,
    title: "Plan",
    kind: "report",
    publishedHtmlLength: 0
  });
  expect((metadataOnly as any).sourcePath).toContain(path.join("resources", "global", "canvases"));
  expect((metadataOnly as any).html).toBeUndefined();
  expect(read.parameters.safeParse({ canvasId: canvas.id, includeHtml: true }).success).toBe(false);
});

test("canvas_read lets overview inspect feature canvases from other threads", async () => {
  const { dir, store, projects, features, agentStore } = freshStoresEnv("md-canvas-read-overview-");
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
    sse: stub<AgentSseEmitter>(new CapturingSse())
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
    kind: "report"
  });
  expect((result as any).sourcePath).toBe(canvas.filePath);
  expect((result as any).html).toBeUndefined();
});

test("canvas_read lets feature agents inspect their feature canvases but not other features", async () => {
  const { dir, store, projects, features, agentStore } = freshStoresEnv("md-canvas-read-feature-");
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
    sse: stub<AgentSseEmitter>(new CapturingSse())
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
});

test("canvas_update renames only and rejects inline HTML parameters", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-update-");
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
    sse: stub<AgentSseEmitter>(sse)
  })[0];
  const update = pack.tools.find((tool) => tool.name === "canvas_update")!;
  // A rename lasts until the next publish, which takes the title from <title>.
  expect(update.description).toContain("every canvas_publish takes the title from the page's <title> when there is one");
  expect(update.parameters.safeParse({
    canvasId: canvas.id,
    title: "Renamed",
    html: "<h1>Changed</h1>"
  }).success).toBe(false);

  const result = await update.handler(
    { canvasId: canvas.id, title: "Renamed" },
    { threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } }
  );

  expect(result).toMatchObject({ ok: true, canvasId: canvas.id, title: "Renamed", link: `[Renamed](/canvas/${canvas.id})` });
  expect(canvasStore.getById(canvas.id)?.title).toBe("Renamed");
  expect(canvasStore.getById(canvas.id)?.html).toBe("<h1>Plan</h1>");
  expect(fs.readFileSync(canvas.filePath!, "utf8")).toBe("<h1>Plan</h1>");
  expect(sse.events).toStrictEqual([
    {
      name: "canvasUpdated",
      data: { canvasId: canvas.id, featureId: null }
    }
  ]);
});

test("feature thread can update and publish same-feature canvases it did not create", async () => {
  const { dir, store, projects, features, agentStore } = freshStoresEnv("md-canvas-feature-edit-");
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
    sse: stub<AgentSseEmitter>(sse)
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
  expect(sse.events).toStrictEqual([
    { name: "canvasUpdated", data: { canvasId: canvas.id, featureId } },
    { name: "canvasUpdated", data: { canvasId: canvas.id, featureId } }
  ]);
});

test("other feature threads cannot update a feature canvas", async () => {
  const { dir, store, projects, features, agentStore } = freshStoresEnv("md-canvas-feature-edit-deny-");
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
    sse: stub<AgentSseEmitter>(new CapturingSse())
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
});

test("canvas_publish refreshes html from the editable source file", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-publish-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({
    title: "Plan [draft] | v2",
    scope: "manager",
    scopeId: null,
    threadId: thread.id
  });
  fs.writeFileSync(canvas.filePath!, "<h1>Edited</h1>", "utf8");

  const sse = new CapturingSse();
  const pack = buildCanvasToolPacks({
    scope: "manager",
    canvasStore,
    sse: stub<AgentSseEmitter>(sse)
  })[0];
  const publish = pack.tools.find((tool) => tool.name === "canvas_publish")!;

  const result = await publish.handler(
    { canvasId: canvas.id },
    { threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } }
  );

  expect(result).toMatchObject({
    ok: true,
    canvasId: canvas.id,
    path: `/canvas/${canvas.id}`,
    // The title's brackets and pipes are escaped, so the link stays one link,
    // in a table too.
    link: `[Plan \\[draft\\] \\| v2](/canvas/${canvas.id})`
  });
  expect((result as any).sourcePath).toBeUndefined();
  expect(canvasStore.getById(canvas.id)?.html).toBe("<h1>Edited</h1>");
  expect(sse.events).toStrictEqual([
    {
      name: "canvasUpdated",
      data: { canvasId: canvas.id, featureId: null }
    }
  ]);
});

test("canvas_publish returns the page checks' warnings, and none for a clean page", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-publish-warnings-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Plan", scope: "manager", scopeId: null, threadId: thread.id });
  const pack = buildCanvasToolPacks({ scope: "manager", canvasStore, sse: stub<AgentSseEmitter>(new CapturingSse()) })[0];
  const publish = pack.tools.find((tool) => tool.name === "canvas_publish")!;
  const ctx = toolContext({ threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } });

  fs.writeFileSync(canvas.filePath!, "<h1>Edited</h1>", "utf8");
  const flagged = await publish.handler({ canvasId: canvas.id }, ctx) as any;
  expect(flagged.ok).toBe(true);
  expect(flagged.warnings.some((w: string) => w.startsWith("No <title>"))).toBe(true);

  fs.writeFileSync(canvas.filePath!, CLEAN_REPORT, "utf8");
  const clean = await publish.handler({ canvasId: canvas.id }, ctx) as any;
  expect(clean.ok).toBe(true);
  expect(clean.warnings).toBeUndefined();
  expect(clean.title).toBe("Cache policy");
});

test("canvas_publish reports the size refusal as an error", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-publish-cap-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Plan", scope: "manager", scopeId: null, threadId: thread.id });
  const pack = buildCanvasToolPacks({ scope: "manager", canvasStore, sse: stub<AgentSseEmitter>(new CapturingSse()) })[0];
  const publish = pack.tools.find((tool) => tool.name === "canvas_publish")!;
  fs.writeFileSync(canvas.filePath!, "a".repeat(16 * 1024 * 1024 + 1), "utf8");
  const result = await publish.handler({ canvasId: canvas.id }, toolContext({ threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } }));
  expect(result).toEqual({ error: expect.stringMatching(/over the 16 MB limit/) });
});

test("a design canvas: created with canvas.json as its source, published with index and artboard warnings, refused by the outline tools", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-design-tool-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const sse = new CapturingSse();
  const pack = buildCanvasToolPacks({ scope: "manager", canvasStore, sse: stub<AgentSseEmitter>(sse), agentStore })[0];
  const tool = (name: string) => pack.tools.find((entry) => entry.name === name)!;
  const ctx = toolContext({ threadId: thread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } });

  const created = await tool("canvas_create").handler({ title: "Checkout", kind: "design" }, ctx) as any;
  expect(created).toMatchObject({ ok: true, kind: "design" });
  expect(path.basename(created.sourcePath)).toBe("canvas.json");

  const folder = path.dirname(created.sourcePath);
  fs.writeFileSync(created.sourcePath, JSON.stringify({ title: "Checkout redesign", boards: {
    "Main.html": { x: 0, y: 0, w: 390, h: 844 },
    "Pay.html": { x: 100, y: 0, w: 390, h: 844 }
  } }));
  fs.writeFileSync(path.join(folder, "Main.html"), "<style>body{background:#fff}</style><main>Cart</main>");
  fs.writeFileSync(path.join(folder, "Pay.html"), '<style>body{background:#fff}</style><img src="https://images.example.com/a.png">');
  const published = await tool("canvas_publish").handler({ canvasId: created.canvasId }, ctx) as any;
  expect(published).toMatchObject({ ok: true, title: "Checkout redesign", artboards: 2 });
  expect(published.warnings).toEqual([
    '"Main.html" and "Pay.html" overlap on the canvas: keep frames 80 px apart within a row and rows 120 px apart.',
    expect.stringMatching(/^Pay\.html: These resources are outside the allowlist and will be blocked: images\.example\.com \(img\)/)
  ]);
  expect(published.chars).toBeUndefined();
  // canvas_read counts a design's artboards; a design has no published HTML of its own.
  const read = await tool("canvas_read").handler({ canvasId: created.canvasId }, ctx) as any;
  expect(read).toMatchObject({ kind: "design", publishedArtboards: 2 });
  expect("publishedHtmlLength" in read).toBe(false);

  for (const name of ["canvas_outline", "canvas_remove_section"]) {
    const args = name === "canvas_outline" ? { canvasId: created.canvasId } : { canvasId: created.canvasId, index: 1, expectLabel: "x" };
    expect(await tool(name).handler(args, ctx)).toEqual({
      error: "canvas_outline and canvas_remove_section work on reports. A design's artboards are listed in its canvas.json: edit that file (or delete an artboard's file and its entry), then call canvas_publish."
    });
  }
});

// A manager reads every canvas, and edits every one too: a worker's report
// it is asked to correct need not go back to the worker.
test("a manager renames, outlines, cuts and publishes a worker's report it did not create", async () => {
  const { dir, store, projects, features, agentStore } = freshStoresEnv("md-canvas-manager-edit-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const featureId = seedFeature(features, projectId, { name: "F", tmuxWindowName: "f" });
  const workerThread = agentStore.getOrCreateThread("worker", featureId);
  const managerThread = agentStore.createManagerThread("Release");
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Worker report", scope: "worker", scopeId: featureId, threadId: workerThread.id, projectId });
  fs.writeFileSync(canvas.filePath!, CLEAN_REPORT, "utf8");
  const sse = new CapturingSse();
  const pack = buildCanvasToolPacks({ scope: "manager", agentStore, canvasStore, sse: stub<AgentSseEmitter>(sse) })[0];
  const tool = (name: string) => pack.tools.find((t) => t.name === name)!;
  const ctx = toolContext({ threadId: managerThread.id, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } });

  expect(await tool("canvas_update").handler({ canvasId: canvas.id, title: "Corrected report" }, ctx)).toMatchObject({ ok: true, title: "Corrected report" });
  const outline = await tool("canvas_outline").handler({ canvasId: canvas.id }, ctx) as { blocks: Array<{ label: string }> };
  expect(outline.blocks.length).toBeGreaterThan(0);
  expect(await tool("canvas_remove_section").handler({ canvasId: canvas.id, index: 1, expectLabel: outline.blocks[0]!.label }, ctx)).toMatchObject({ note: "source updated; call canvas_publish to render it" });
  expect(await tool("canvas_publish").handler({ canvasId: canvas.id }, ctx)).toMatchObject({ ok: true, canvasId: canvas.id });
  expect(canvasStore.getById(canvas.id)!.html).toBe(fs.readFileSync(canvas.filePath!, "utf8"));
  // Its feature's list hears of it.
  expect(sse.events.at(-1)).toEqual({ name: "canvasUpdated", data: { canvasId: canvas.id, featureId } });
});

test("canvas_update and canvas_publish say a manager can edit and publish any canvas", () => {
  const { dir, store } = freshStoresEnv("md-canvas-manager-words-");
  const pack = buildCanvasToolPacks({ scope: "manager", canvasStore: new CanvasStore(store.db, dir), sse: stub<AgentSseEmitter>(new CapturingSse()) })[0];
  const description = (name: string) => pack.tools.find((t) => t.name === name)!.description;
  expect(description("canvas_update")).toContain("The creating thread can edit its canvas; a feature's main agent thread can edit canvases bound to that feature; a manager can edit any canvas.");
  expect(description("canvas_publish")).toContain("The creating thread can publish its canvas; a feature's main agent thread can publish canvases bound to that feature; a manager can publish any canvas.");
});

test("canvas_update says a design's title also comes back from canvas.json", () => {
  const { dir, store } = freshStoresEnv("md-canvas-update-design-");
  const pack = buildCanvasToolPacks({ scope: "manager", canvasStore: new CanvasStore(store.db, dir), sse: stub<AgentSseEmitter>(new CapturingSse()) })[0];
  const update = pack.tools.find((tool) => tool.name === "canvas_update")!;
  expect(update.description).toContain("and a design's from canvas.json's title when there is one");
  const publish = pack.tools.find((tool) => tool.name === "canvas_publish")!;
  expect(publish.description).toContain("a report's missing <title>");
});
