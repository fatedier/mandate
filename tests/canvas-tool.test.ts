import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { buildCanvasToolPacks } from "../src/server/modules/canvas/tool-packs.js";
import { canvasDescription } from "../src/server/modules/canvas/canvas-contract.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { ToolContext, ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { CLEAN_REPORT } from "./helpers/canvas-pages.js";
import { stub, toolContext } from "./helpers/typed.js";

type CanvasResult = { ok: true; canvasId: string; path: string; title?: string; sourcePath?: string } | { error: string };

class CapturingSse {
  events: Array<{ name: string; data: any }> = [];
  emit(name: string, data: any) {
    this.events.push({ name, data });
  }
}

/** The one canvas tool as the scope's agent gets it. */
function canvasTool(input: { scope: "manager" | "worker"; canvasStore: CanvasStore; sse?: CapturingSse; agentStore?: AgentStore }): ToolDefinition<any, any> {
  const packs = buildCanvasToolPacks({ scope: input.scope, canvasStore: input.canvasStore, sse: stub<AgentSseEmitter>(input.sse ?? new CapturingSse()), ...(input.agentStore ? { agentStore: input.agentStore } : {}) });
  const tools = packs.flatMap((pack) => pack.tools);
  expect(tools.map((tool) => tool.name)).toEqual(["canvas"]);
  return tools[0]!;
}

const managerCtx = (threadId: string): ToolContext =>
  toolContext({ threadId, wakeId: "wake", scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } });

function workerCtx(threadId: string, worker: NonNullable<ToolContext["worker"]>, project: NonNullable<ToolContext["project"]>): ToolContext {
  return toolContext({
    threadId,
    wakeId: "wake",
    scope: { kind: "worker", worker: { workingDir: worker.worktreePath }, project: { workingDir: project.workingDir } },
    worker,
    project
  });
}

test("create stores a worker-scoped canvas without opening it", async () => {
  const { dir, store, projects, workers, agentStore } = freshStoresEnv("md-canvas-tool-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const workerId = seedWorker(workers, projectId, { name: "F", tmuxWindowName: "f" });
  const project = projects.getById(projectId)!;
  const worker = workers.getById(workerId)!;
  const thread = agentStore.getOrCreateThread("worker", workerId);
  const canvasStore = new CanvasStore(store.db, dir);
  const sse = new CapturingSse();
  const tool = canvasTool({ scope: "worker", canvasStore, sse });

  const result = (await tool.handler({ action: "create", title: "Implementation plan" }, workerCtx(thread.id, worker, project))) as CanvasResult;

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
  expect(canvas.scopeId).toBe(workerId);
  expect(canvas.projectId).toBe(projectId);
  expect(canvas.threadId).toBe(thread.id);
  expect(canvas.kind).toBe("report");
  expect(result.sourcePath).toBe(canvas.filePath!);
  expect(result.sourcePath).toContain(path.join("resources", "projects", projectId, "canvases"));
  expect(fs.existsSync(path.dirname(canvas.filePath!))).toBe(true);
  expect(fs.existsSync(canvas.filePath!)).toBe(false);
  expect(canvas.html).toBe("");
  expect(sse.events).toStrictEqual([
    { name: "canvasUpdated", data: { canvasId: canvas.id, workerId } }
  ]);
});

test("a worker's canvas tool takes no projectId; a manager's takes one; neither takes inline HTML, a worker binding or another kind", () => {
  const { dir, store } = freshStoresEnv("md-canvas-tool-schema-");
  const canvasStore = new CanvasStore(store.db, dir);
  const worker = canvasTool({ scope: "worker", canvasStore });
  expect(worker.parameters.parse({ action: "create", title: "hello" })).toMatchObject({ action: "create", title: "hello" });
  expect(worker.parameters.safeParse({ action: "create", title: "hello", projectId: "p" }).success).toBe(false);
  const manager = canvasTool({ scope: "manager", canvasStore });
  expect(manager.parameters.parse({ action: "create", title: "hello", projectId: "p" })).toMatchObject({ projectId: "p" });
  for (const tool of [worker, manager]) {
    // Binding a dashboard to the worker was retired with the worker plan.
    expect(tool.parameters.safeParse({ action: "create", title: "hello", bindToWorker: true }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: "create", title: "Plan", html: "<h1>Plan</h1>" }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: "create", title: "Draft", kind: "design" }).success).toBe(true);
    expect(tool.parameters.safeParse({ action: "create", title: "Draft", kind: "report" }).success).toBe(true);
    expect(tool.parameters.safeParse({ action: "create", title: "Draft", kind: "html" }).success).toBe(false);
    // canvas_update's rename is gone with it.
    expect(tool.parameters.safeParse({ action: "update", canvasId: "cnv_1", title: "Renamed" }).success).toBe(false);
  }
});

test("manager-created canvases notify lists without claiming a Worker owner", async () => {
  const { dir, store, projects, agentStore } = freshStoresEnv("md-canvas-create-manager-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const thread = agentStore.getOrCreateThread("manager", null);
  const sse = new CapturingSse();
  const tool = canvasTool({ scope: "manager", canvasStore: new CanvasStore(store.db, dir), sse });
  for (const owner of [undefined, projectId]) {
    const result = (await tool.handler({ action: "create", title: "Manager artifact", ...(owner ? { projectId: owner } : {}) }, managerCtx(thread.id))) as CanvasResult;
    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result)) throw new Error("expected a created canvas");
    expect(sse.events.at(-1)).toEqual({ name: "canvasUpdated", data: { canvasId: result.canvasId, workerId: null } });
  }
  expect(sse.events).toHaveLength(2);
});

test("the canvas tool's description is its scope's: a worker's create names its plan step, a manager's a project", () => {
  const { dir, store } = freshStoresEnv("md-canvas-tool-description-");
  const canvasStore = new CanvasStore(store.db, dir);
  for (const scope of ["manager", "worker"] as const) {
    expect(canvasTool({ scope, canvasStore }).description).toBe(canvasDescription(scope === "worker"));
  }
  expect(canvasDescription(true)).toContain("The worker's project is applied automatically.");
  expect(canvasDescription(true)).toContain("Put the canvas's id in the note of the plan step it belongs to, and the app links it from the plan.");
  expect(canvasDescription(true)).not.toContain("projectId");
  expect(canvasDescription(false)).toContain("Give projectId to store it under a project; omit it for a global canvas.");
});

test("each action refuses a field another action takes, by name; a blank one is no field", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-misplaced-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Plan", scope: "manager", scopeId: null, threadId: thread.id });
  fs.writeFileSync(canvas.filePath!, CLEAN_REPORT, "utf8");
  const tool = canvasTool({ scope: "manager", canvasStore, agentStore });
  const call = (args: Record<string, unknown>) => tool.handler(tool.parameters.parse(args), managerCtx(thread.id));

  for (const [args, error] of [
    [{ action: "publish", canvasId: canvas.id, title: "Renamed" }, "`title` goes only with create"],
    [{ action: "read", canvasId: canvas.id, kind: "design" }, "`kind` goes only with create"],
    [{ action: "outline", canvasId: canvas.id, projectId: "proj_1" }, "`projectId` goes only with create"],
    [{ action: "publish", canvasId: canvas.id, index: 2 }, "`index` goes only with remove_section"],
    [{ action: "create", title: "New", expectLabel: "Intro" }, "`expectLabel` goes only with remove_section"],
    [{ action: "create", title: "New", canvasId: canvas.id }, "create makes a new canvas and takes no canvasId"],
    [{ action: "create" }, "create needs a title"],
    [{ action: "create", title: "  " }, "create needs a title"],
    [{ action: "publish" }, "give the canvas's id"],
    [{ action: "read", canvasId: " " }, "give the canvas's id"],
    [{ action: "remove_section", canvasId: canvas.id }, "remove_section needs index and expectLabel"]
  ] as const) {
    expect([args, await call(args)]).toEqual([args, { error }]);
  }
  expect(canvasStore.getById(canvas.id)!.title).toBe("Plan");

  // What a model sends for a field it has nothing for is not refused.
  expect(await call({ action: "publish", canvasId: canvas.id, title: "", kind: "", projectId: "", index: 0, expectLabel: "" }))
    .toMatchObject({ ok: true, canvasId: canvas.id });
  // A blank kind is a report, the default.
  expect(await call({ action: "create", title: "Fresh", kind: "", canvasId: "", index: 0, expectLabel: "" })).toMatchObject({ ok: true, title: "Fresh", kind: "report" });
  for (const scope of ["worker", "manager"] as const) {
    expect(canvasTool({ scope, canvasStore }).parameters.safeParse({ action: "read", canvasId: canvas.id, kind: "" }).success).toBe(true);
  }
});

test("read returns metadata and sourcePath only", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-read-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Plan", scope: "manager", scopeId: null, threadId: thread.id });
  const tool = canvasTool({ scope: "manager", canvasStore });

  const metadataOnly = await tool.handler({ action: "read", canvasId: canvas.id }, managerCtx(thread.id));
  expect(metadataOnly).toMatchObject({ canvasId: canvas.id, title: "Plan", kind: "report", publishedHtmlLength: 0 });
  expect((metadataOnly as any).sourcePath).toContain(path.join("resources", "global", "canvases"));
  expect((metadataOnly as any).html).toBeUndefined();
  expect(tool.parameters.safeParse({ action: "read", canvasId: canvas.id, includeHtml: true }).success).toBe(false);
});

test("read lets a manager inspect worker canvases from other threads", async () => {
  const { dir, store, projects, workers, agentStore } = freshStoresEnv("md-canvas-read-overview-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const workerId = seedWorker(workers, projectId, { name: "F", tmuxWindowName: "f" });
  const workerThread = agentStore.getOrCreateThread("worker", workerId);
  const managerThread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Worker dashboard", scope: "worker", scopeId: workerId, threadId: workerThread.id, projectId });
  const tool = canvasTool({ scope: "manager", canvasStore, agentStore });

  const result = await tool.handler({ action: "read", canvasId: canvas.id }, managerCtx(managerThread.id));

  expect(result).toMatchObject({ canvasId: canvas.id, title: "Worker dashboard", kind: "report" });
  expect((result as any).sourcePath).toBe(canvas.filePath);
  expect((result as any).html).toBeUndefined();
});

test("read lets worker agents inspect their worker canvases but not other workers'", async () => {
  const { dir, store, projects, workers, agentStore } = freshStoresEnv("md-canvas-read-worker-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const workerId = seedWorker(workers, projectId, { name: "F", tmuxWindowName: "f" });
  const otherWorkerId = seedWorker(workers, projectId, { name: "Other", tmuxWindowName: "other" });
  const project = projects.getById(projectId)!;
  const ownerThread = agentStore.getOrCreateThread("worker", workerId);
  const otherThread = agentStore.getOrCreateThread("worker", otherWorkerId);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Worker dashboard", scope: "worker", scopeId: workerId, threadId: ownerThread.id, projectId });
  const tool = canvasTool({ scope: "worker", canvasStore, agentStore });

  expect(await tool.handler({ action: "read", canvasId: canvas.id }, workerCtx(ownerThread.id, workers.getById(workerId)!, project)))
    .toMatchObject({ canvasId: canvas.id });
  expect(await tool.handler({ action: "read", canvasId: canvas.id }, workerCtx(otherThread.id, workers.getById(otherWorkerId)!, project)))
    .toEqual({ error: "canvas is not visible from this agent scope" });
});

test("a worker thread publishes a same-worker canvas it did not create; another worker's thread cannot", async () => {
  const { dir, store, projects, workers, agentStore } = freshStoresEnv("md-canvas-worker-edit-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const workerId = seedWorker(workers, projectId, { name: "F", tmuxWindowName: "f" });
  const otherWorkerId = seedWorker(workers, projectId, { name: "Other", tmuxWindowName: "other" });
  const project = projects.getById(projectId)!;
  const ownerThread = agentStore.getOrCreateThread("manager", null);
  const workerThread = agentStore.getOrCreateThread("worker", workerId);
  const otherThread = agentStore.getOrCreateThread("worker", otherWorkerId);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Draft dashboard", scope: "worker", scopeId: workerId, threadId: ownerThread.id, projectId });
  fs.writeFileSync(canvas.filePath!, "<h1>Published by main thread</h1>", "utf8");
  const sse = new CapturingSse();
  const tool = canvasTool({ scope: "worker", canvasStore, sse, agentStore });

  expect(await tool.handler({ action: "publish", canvasId: canvas.id }, workerCtx(otherThread.id, workers.getById(otherWorkerId)!, project)))
    .toEqual({ error: "canvas is not editable from this agent scope" });
  expect(canvasStore.getById(canvas.id)!.html).toBe("");

  expect(await tool.handler({ action: "publish", canvasId: canvas.id }, workerCtx(workerThread.id, workers.getById(workerId)!, project)))
    .toMatchObject({ ok: true, canvasId: canvas.id });
  expect(canvasStore.getById(canvas.id)!.html).toBe("<h1>Published by main thread</h1>");
  expect(sse.events).toStrictEqual([{ name: "canvasUpdated", data: { canvasId: canvas.id, workerId } }]);
});

test("publish refreshes html from the editable source file", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-publish-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Plan [draft] | v2", scope: "manager", scopeId: null, threadId: thread.id });
  fs.writeFileSync(canvas.filePath!, "<h1>Edited</h1>", "utf8");
  const sse = new CapturingSse();
  const tool = canvasTool({ scope: "manager", canvasStore, sse });

  const result = await tool.handler({ action: "publish", canvasId: canvas.id }, managerCtx(thread.id));

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
  expect(sse.events).toStrictEqual([{ name: "canvasUpdated", data: { canvasId: canvas.id, workerId: null } }]);
});

test("publish returns the page checks' warnings, and none for a clean page", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-publish-warnings-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Plan", scope: "manager", scopeId: null, threadId: thread.id });
  const tool = canvasTool({ scope: "manager", canvasStore });

  fs.writeFileSync(canvas.filePath!, "<h1>Edited</h1>", "utf8");
  const flagged = await tool.handler({ action: "publish", canvasId: canvas.id }, managerCtx(thread.id)) as any;
  expect(flagged.ok).toBe(true);
  expect(flagged.warnings.some((w: string) => w.startsWith("No <title>"))).toBe(true);

  fs.writeFileSync(canvas.filePath!, CLEAN_REPORT, "utf8");
  const clean = await tool.handler({ action: "publish", canvasId: canvas.id }, managerCtx(thread.id)) as any;
  expect(clean.ok).toBe(true);
  expect(clean.warnings).toBeUndefined();
  expect(clean.title).toBe("Cache policy");
});

test("publish says when a report runs long, naming outline and remove_section", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-publish-long-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Plan", scope: "manager", scopeId: null, threadId: thread.id });
  fs.writeFileSync(canvas.filePath!, `<title>Long</title><main>${Array.from({ length: 12 }, (_, i) => `<section><h2>Part ${i}</h2><p>${"word ".repeat(200)}</p></section>`).join("")}</main>`, "utf8");
  const tool = canvasTool({ scope: "manager", canvasStore });
  const result = await tool.handler({ action: "publish", canvasId: canvas.id }, managerCtx(thread.id)) as { note?: string; chars: number; blocks: number };
  expect(result.note).toBe(
    `This canvas is ${result.chars} characters across ${result.blocks} blocks, past the ~8000 a reader will take in. ` +
    "Use outline to see which blocks carry the bulk, and remove_section for anything now superseded."
  );
});

test("publish reports the size refusal as an error", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-publish-cap-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Plan", scope: "manager", scopeId: null, threadId: thread.id });
  const tool = canvasTool({ scope: "manager", canvasStore });
  fs.writeFileSync(canvas.filePath!, "a".repeat(16 * 1024 * 1024 + 1), "utf8");
  expect(await tool.handler({ action: "publish", canvasId: canvas.id }, managerCtx(thread.id))).toEqual({ error: expect.stringMatching(/over the 16 MB limit/) });
});

test("a design canvas: created with canvas.json as its source, published with index and artboard warnings, refused by outline and remove_section", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-design-tool-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvasStore = new CanvasStore(store.db, dir);
  const tool = canvasTool({ scope: "manager", canvasStore, agentStore });
  const ctx = managerCtx(thread.id);

  const created = await tool.handler({ action: "create", title: "Checkout", kind: "design" }, ctx) as any;
  expect(created).toMatchObject({ ok: true, kind: "design" });
  expect(path.basename(created.sourcePath)).toBe("canvas.json");

  const folder = path.dirname(created.sourcePath);
  fs.writeFileSync(created.sourcePath, JSON.stringify({ title: "Checkout redesign", boards: {
    "Main.html": { x: 0, y: 0, w: 390, h: 844 },
    "Pay.html": { x: 100, y: 0, w: 390, h: 844 }
  } }));
  fs.writeFileSync(path.join(folder, "Main.html"), "<style>body{background:#fff}</style><main>Cart</main>");
  fs.writeFileSync(path.join(folder, "Pay.html"), '<style>body{background:#fff}</style><img src="https://images.example.com/a.png">');
  const published = await tool.handler({ action: "publish", canvasId: created.canvasId }, ctx) as any;
  expect(published).toMatchObject({ ok: true, title: "Checkout redesign", artboards: 2 });
  expect(published.warnings).toEqual([
    '"Main.html" and "Pay.html" overlap on the canvas: keep frames 80 px apart within a row and rows 120 px apart.',
    expect.stringMatching(/^Pay\.html: These resources are outside the allowlist and will be blocked: images\.example\.com \(img\)/)
  ]);
  expect(published.chars).toBeUndefined();
  // read counts a design's artboards; a design has no published HTML of its own.
  const read = await tool.handler({ action: "read", canvasId: created.canvasId }, ctx) as any;
  expect(read).toMatchObject({ kind: "design", publishedArtboards: 2 });
  expect("publishedHtmlLength" in read).toBe(false);

  for (const args of [{ action: "outline", canvasId: created.canvasId }, { action: "remove_section", canvasId: created.canvasId, index: 1, expectLabel: "x" }]) {
    expect(await tool.handler(args, ctx)).toEqual({
      error: "outline and remove_section work on reports. A design's artboards are listed in its canvas.json: edit that file (or delete an artboard's file and its entry), then publish."
    });
  }
});

// A manager reads every canvas, and edits every one too: a worker's report
// it is asked to correct need not go back to the worker.
test("a manager outlines, cuts and publishes a worker's report it did not create", async () => {
  const { dir, store, projects, workers, agentStore } = freshStoresEnv("md-canvas-manager-edit-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const workerId = seedWorker(workers, projectId, { name: "F", tmuxWindowName: "f" });
  const workerThread = agentStore.getOrCreateThread("worker", workerId);
  const managerThread = agentStore.createManagerThread("Release");
  const canvasStore = new CanvasStore(store.db, dir);
  const canvas = canvasStore.create({ title: "Worker report", scope: "worker", scopeId: workerId, threadId: workerThread.id, projectId });
  fs.writeFileSync(canvas.filePath!, CLEAN_REPORT, "utf8");
  const sse = new CapturingSse();
  const tool = canvasTool({ scope: "manager", canvasStore, sse, agentStore });
  const ctx = managerCtx(managerThread.id);

  const outline = await tool.handler({ action: "outline", canvasId: canvas.id }, ctx) as { blocks: Array<{ index: number; label: string }> };
  expect(outline.blocks.length).toBeGreaterThan(0);
  const first = outline.blocks[0]!;
  expect(await tool.handler({ action: "remove_section", canvasId: canvas.id, index: first.index, expectLabel: `${first.label} (moved)` }, ctx))
    .toEqual({ error: expect.stringContaining("run outline again; indices move when anything is removed") });
  expect(await tool.handler({ action: "remove_section", canvasId: canvas.id, index: first.index, expectLabel: first.label }, ctx))
    .toMatchObject({ note: "source updated; publish to render it" });
  expect(await tool.handler({ action: "publish", canvasId: canvas.id }, ctx)).toMatchObject({ ok: true, canvasId: canvas.id });
  expect(canvasStore.getById(canvas.id)!.html).toBe(fs.readFileSync(canvas.filePath!, "utf8"));
  // Its worker's list hears of it.
  expect(sse.events.at(-1)).toEqual({ name: "canvasUpdated", data: { canvasId: canvas.id, workerId } });
});

// The personal agent makes canvases of its own (a report, a design of its page) with
// the manager's tools, as a global canvas of its conversation. It reads every
// canvas; a thread's it does not change: that goes back to the thread.
test("The personal agent makes a global canvas of its own and changes it; a thread's it reads but cannot change", async () => {
  const { dir, store, projects, workers, agentStore } = freshStoresEnv("md-canvas-your-agent-");
  const projectId = seedProject(projects, { name: "P", tmuxSessionName: "md-p" });
  const workerId = seedWorker(workers, projectId, { name: "F", tmuxWindowName: "f" });
  const workerThread = agentStore.getOrCreateThread("worker", workerId);
  const personal = agentStore.getOrCreatePersonalThread();
  const canvasStore = new CanvasStore(store.db, dir);
  const theirs = canvasStore.create({ title: "Worker report", scope: "worker", scopeId: workerId, threadId: workerThread.id, projectId });
  fs.writeFileSync(theirs.filePath!, CLEAN_REPORT, "utf8");
  const tool = canvasTool({ scope: "manager", canvasStore, agentStore });
  // Its tool scope is the manager's kind, in the personal agent's thread.
  const ctx = managerCtx(personal.id);

  const made = await tool.handler({ action: "create", title: "Page, two directions" }, ctx) as { ok: true; canvasId: string; sourcePath: string };
  expect(made).toMatchObject({ ok: true, kind: "report" });
  expect(canvasStore.getById(made.canvasId)).toMatchObject({ scope: "manager", scopeId: null, projectId: null, threadId: personal.id });
  fs.writeFileSync(made.sourcePath, CLEAN_REPORT, "utf8");
  expect(await tool.handler({ action: "publish", canvasId: made.canvasId }, ctx)).toMatchObject({ ok: true, canvasId: made.canvasId });
  expect(await tool.handler({ action: "outline", canvasId: made.canvasId }, ctx)).toMatchObject({ blocks: expect.any(Array) });

  expect(await tool.handler({ action: "read", canvasId: theirs.id }, ctx)).toMatchObject({ canvasId: theirs.id, title: "Worker report" });
  for (const args of [
    { action: "publish", canvasId: theirs.id },
    { action: "outline", canvasId: theirs.id },
    { action: "remove_section", canvasId: theirs.id, index: 1, expectLabel: "x" }
  ]) {
    expect([args.action, await tool.handler(args, ctx)]).toEqual([args.action, { error: "canvas is not editable from this agent scope" }]);
  }
  expect(canvasStore.getById(theirs.id)!.html).toBe("");
});

test("an unknown canvas is named as such for every action that takes one", async () => {
  const { dir, store, agentStore } = freshStoresEnv("md-canvas-unknown-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const tool = canvasTool({ scope: "manager", canvasStore: new CanvasStore(store.db, dir), agentStore });
  for (const args of [
    { action: "publish", canvasId: "cnv_missing" },
    { action: "read", canvasId: "cnv_missing" },
    { action: "outline", canvasId: "cnv_missing" },
    { action: "remove_section", canvasId: "cnv_missing", index: 1, expectLabel: "x" }
  ]) {
    expect([args.action, await tool.handler(args, managerCtx(thread.id))]).toEqual([args.action, { error: "canvas not found" }]);
  }
});
