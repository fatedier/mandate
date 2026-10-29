import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { CANVAS_PAGE_MAX_BYTES } from "../src/shared/canvas-page.js";
import { freshAgentEnv, freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("CanvasStore creates, updates and publishes", () => {
  const { dir, store, agentStore } = freshAgentEnv("md-canvas-");
  const canvasStore = new CanvasStore(store.db, dir);
  const thread = agentStore.getOrCreateThread("manager", null);

  const created = canvasStore.create({
    title: "Plan",
    scope: "manager",
    scopeId: null,
    threadId: thread.id
  });

  expect(created.title).toBe("Plan");
  expect(created.kind).toBe("report");
  expect(created.contentRevision).toBe(0);
  expect(created.threadId).toBe(thread.id);
  expect(created.filePath).toContain(path.join("resources", "global", "canvases", created.id));
  expect(fs.existsSync(path.dirname(created.filePath!))).toBe(true);
  expect(fs.existsSync(created.filePath!)).toBe(false);
  expect(canvasStore.getById(created.id)?.html).toBe("");
  const columns = (store.db.prepare("pragma table_info(canvas_documents)").all() as Array<{ name: string }>)
    .map((column) => column.name);
  expect(columns).toEqual([
    "id",
    "title",
    "html",
    "scope",
    "scope_id",
    "project_id",
    "file_path",
    "thread_id",
    "created_at",
    "updated_at",
    "content_revision",
    "kind"
  ]);

  fs.writeFileSync(created.filePath!, "<h1>Plan</h1>", "utf8");
  const published = canvasStore.publishSource(created.id);
  expect(published.error).toBeUndefined();
  expect(published.canvas?.html).toBe("<h1>Plan</h1>");
  expect(published.canvas?.contentRevision).toBe(1);

  const updated = canvasStore.update({
    id: created.id,
    title: "Updated plan"
  });
  expect(updated?.title).toBe("Updated plan");
  expect(updated?.html).toBe("<h1>Plan</h1>");
  expect(updated?.contentRevision).toBe(1);
  expect(fs.readFileSync(updated!.filePath!, "utf8")).toBe("<h1>Plan</h1>");

  fs.writeFileSync(path.join(path.dirname(created.filePath!), "label.js"), "const version = 2;");
  const republished = canvasStore.publishSource(created.id).canvas!;
  expect(republished.html).toBe(published.canvas!.html);
  expect(republished.contentRevision).toBe(2);
  expect(new CanvasStore(store.db, dir).getById(created.id)?.contentRevision).toBe(2);

});

test("CanvasStore lists feature canvases without html and with navigation context", () => {
  const { dir, store, projects, features, agentStore } = freshStoresEnv("md-canvas-list-");
  const canvasStore = new CanvasStore(store.db, dir);
  const projectId = seedProject(projects, {
    name: "Mandate",
    tmuxSessionName: "md-mandate"
  });
  const featureId = seedFeature(features, projectId, {
    name: "Canvas browser",
    tmuxWindowName: "canvas_browser"
  });
  const thread = agentStore.getOrCreateThread("worker", featureId);
  const oldCanvas = canvasStore.create({
    title: "Old plan",
    scope: "worker",
    scopeId: featureId,
    threadId: thread.id,
    projectId
  });
  const newCanvas = canvasStore.create({
    title: "New plan",
    scope: "worker",
    scopeId: featureId,
    threadId: thread.id,
    projectId
  });
  store.db.prepare("update canvas_documents set updated_at = ? where id = ?")
    .run("2026-05-09T00:00:00.000Z", oldCanvas.id);
  store.db.prepare("update canvas_documents set updated_at = ? where id = ?")
    .run("2026-05-10T00:00:00.000Z", newCanvas.id);

  const list = canvasStore.listForFeature(featureId);
  expect(list.map((canvas) => canvas.id)).toEqual([newCanvas.id, oldCanvas.id]);
  expect(list[0]).toMatchObject({
    title: "New plan",
    kind: "report",
    projectId,
    projectName: "Mandate",
    projectSlug: "md-mandate",
    featureId,
    featureName: "Canvas browser",
    featureSlug: "canvas_browser"
  });
  expect("html" in list[0]!).toBe(false);

  expect(canvasStore.getById(newCanvas.id)).toMatchObject({
    title: "New plan",
    kind: "report",
    projectId,
    projectName: "Mandate",
    projectSlug: "md-mandate",
    featureId,
    featureName: "Canvas browser",
    featureSlug: "canvas_browser"
  });
});

test("publishSource takes the title from <title> and keeps the old one without it", () => {
  const { dir, store, agentStore } = freshAgentEnv("md-canvas-title-");
  const canvasStore = new CanvasStore(store.db, dir);
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Draft", scope: "manager", scopeId: null, threadId: thread.id });
  fs.writeFileSync(canvas.filePath!, "<title>Cache rules &amp; warm-up</title><h1>x</h1>", "utf8");
  expect(canvasStore.publishSource(canvas.id).canvas?.title).toBe("Cache rules & warm-up");
  fs.writeFileSync(canvas.filePath!, "<h1>No title now</h1>", "utf8");
  expect(canvasStore.publishSource(canvas.id).canvas?.title).toBe("Cache rules & warm-up");
});

test("publishSource refuses a page over 16 MB and publishes one at the limit", () => {
  expect(CANVAS_PAGE_MAX_BYTES).toBe(16 * 1024 * 1024);
  const { dir, store, agentStore } = freshAgentEnv("md-canvas-cap-");
  const canvasStore = new CanvasStore(store.db, dir);
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Big", scope: "manager", scopeId: null, threadId: thread.id });
  fs.writeFileSync(canvas.filePath!, "a".repeat(CANVAS_PAGE_MAX_BYTES + 1), "utf8");
  const refused = canvasStore.publishSource(canvas.id);
  expect(refused.error).toMatch(/over the 16 MB limit/);
  expect(refused.error).toMatch(/next to index\.html/);
  expect(canvasStore.getById(canvas.id)?.contentRevision).toBe(0);
  fs.writeFileSync(canvas.filePath!, "a".repeat(CANVAS_PAGE_MAX_BYTES), "utf8");
  expect(canvasStore.publishSource(canvas.id).error).toBeUndefined();
  expect(canvasStore.getById(canvas.id)?.contentRevision).toBe(1);
});

test("publishSource refuses a huge page without reading it into memory", () => {
  const { dir, store, agentStore } = freshAgentEnv("md-canvas-huge-");
  const canvasStore = new CanvasStore(store.db, dir);
  const thread = agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Huge", scope: "manager", scopeId: null, threadId: thread.id });
  // A sparse 3 GB file: too long for a string, so reading it first fails differently.
  fs.writeFileSync(canvas.filePath!, "");
  fs.truncateSync(canvas.filePath!, 3 * 1024 * 1024 * 1024);
  expect(canvasStore.publishSource(canvas.id).error).toMatch(/over the 16 MB limit/);
});

function designEnv(prefix: string) {
  const env = freshAgentEnv(prefix);
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Draft", scope: "manager", scopeId: null, threadId: thread.id, kind: "design" });
  const folder = path.dirname(canvas.filePath!);
  const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), text, "utf8");
  };
  return { ...env, canvasStore, canvas, folder, write };
}

test("a canvas.json over the size limit is refused before it is read", () => {
  const env = designEnv("md-design-big-index-");
  try {
    // Sparse: 17 MB on paper, nothing written.
    fs.writeFileSync(path.join(env.folder, "canvas.json"), "");
    fs.truncateSync(path.join(env.folder, "canvas.json"), 17 * 1024 * 1024);
    expect(env.canvasStore.publishSource(env.canvas.id).error).toMatch(/^canvas\.json is 17\.0 MB, over the 16 MB limit/);
  } finally {
    env.cleanup();
  }
});

test("a stored design that is JSON but not a snapshot reads as unpublished", () => {
  const env = designEnv("md-design-bad-snapshot-");
  try {
    for (const stored of [
      // Not JSON at all: unreadable, never a throw.
      "{not json",
      "{}", '{"index":{"boards":"x"},"artboards":{}}', '{"index":{"boards":[]}}', "[]", "null",
      // Every container right, but nothing a publish could write: no board, no page, no launch view.
      '{"index":{"boards":[],"pages":[],"notes":[],"launch":{}},"artboards":{}}',
      // A good index, but artboards is a list, not a map of pages.
      '{"index":{"boards":[{"path":"Main.html"}],"pages":[{"id":"main","name":""}],"notes":[],"launch":{"view":"canvas","page":"main"}},"artboards":[]}'
    ]) {
      env.store.db.prepare("update canvas_documents set html = ? where id = ?").run(stored, env.canvas.id);
      expect(env.canvasStore.getById(env.canvas.id)!.design === undefined).toBe(true);
    }
  } finally {
    env.cleanup();
  }
});

test("publishing a design stores the index and every listed artboard, and takes the title from the index", () => {
  const env = designEnv("md-design-publish-");
  try {
    // Until it is published, a design canvas has no design to show.
    expect(env.canvas.design).toBeUndefined();
    env.write("canvas.json", JSON.stringify({ v: 3, title: "Checkout redesign", boards: {
      "Main.html": { x: 0, y: 0, w: 390, h: 844 },
      "screens/Pay.html": { x: 470, y: 0, w: 390, h: 844 }
    } }));
    env.write("Main.html", "<title>Cart</title><main>Cart</main>");
    env.write("screens/Pay.html", "<title>Pay</title><main>Pay</main>");
    env.write("Unlisted.html", "<p>not published</p>");
    const published = env.canvasStore.publishSource(env.canvas.id);
    expect(published.error).toBeUndefined();
    expect(published.warnings).toEqual([]);
    const canvas = published.canvas!;
    expect(canvas.title).toBe("Checkout redesign");
    expect(canvas.contentRevision).toBe(1);
    expect(canvas.html).toBe("");
    expect(canvas.design!.index.boards.map((b) => b.path)).toEqual(["Main.html", "screens/Pay.html"]);
    expect(canvas.design!.artboards).toEqual({
      "Main.html": "<title>Cart</title><main>Cart</main>",
      "screens/Pay.html": "<title>Pay</title><main>Pay</main>"
    });
    // Editing files shows nothing until the next publish.
    env.write("Main.html", "<p>changed</p>");
    expect(env.canvasStore.getById(env.canvas.id)!.design!.artboards["Main.html"]).toBe("<title>Cart</title><main>Cart</main>");
  } finally {
    env.cleanup();
  }
});

test("a design without a title keeps its create title, and index warnings come back", () => {
  const env = designEnv("md-design-warn-");
  try {
    env.write("canvas.json", JSON.stringify({ boards: { "Main.html": { x: 0, y: 0, w: 20, h: 844 } } }));
    env.write("Main.html", "<p>x</p>");
    const published = env.canvasStore.publishSource(env.canvas.id);
    expect(published.canvas!.title).toBe("Draft");
    expect(published.warnings).toEqual(['"Main.html" is 20×844: an artboard\'s w and h are 40–8000 px.']);
  } finally {
    env.cleanup();
  }
});

test("a design publish is refused for a missing index, a missing artboard, or over 16 MB in total", () => {
  const env = designEnv("md-design-refuse-");
  try {
    expect(env.canvasStore.publishSource(env.canvas.id).error).toMatch(/^No canvas\.json yet: write the index at /);
    env.write("canvas.json", JSON.stringify({ boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 }, "Two.html": { x: 470, y: 0, w: 390, h: 844 } } }));
    env.write("Main.html", "<p>x</p>");
    expect(env.canvasStore.publishSource(env.canvas.id).error).toBe('"Two.html" is listed in canvas.json but not found next to it.');
    env.write("Two.html", "");
    // Sized on disk before reading: sparse files make this fast.
    fs.truncateSync(path.join(env.folder, "Main.html"), 9 * 1024 * 1024);
    fs.truncateSync(path.join(env.folder, "Two.html"), 9 * 1024 * 1024);
    expect(env.canvasStore.publishSource(env.canvas.id).error).toMatch(/^The design is 18\.0 MB across canvas\.json and its artboards, over the 16 MB limit\./);
    expect(env.canvasStore.getById(env.canvas.id)!.contentRevision).toBe(0);
  } finally {
    env.cleanup();
  }
});

test("an artboard or canvas.json that is not a regular file is refused before it is read", () => {
  // A folder stands in for a named pipe, which a read would block on.
  const env = designEnv("md-design-not-a-file-");
  try {
    env.write("canvas.json", JSON.stringify({ boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } } }));
    fs.mkdirSync(path.join(env.folder, "Main.html"));
    expect(env.canvasStore.publishSource(env.canvas.id).error).toBe('"Main.html" is not a file.');
    fs.rmSync(path.join(env.folder, "canvas.json"));
    fs.mkdirSync(path.join(env.folder, "canvas.json"));
    expect(env.canvasStore.publishSource(env.canvas.id).error).toBe("canvas.json is not a file.");
  } finally {
    env.cleanup();
  }
});

test("a canvas.json that is a symlink out of the canvas folder is refused before it is read", () => {
  const env = designEnv("md-design-index-symlink-");
  const outside = fs.mkdtempSync(path.join(path.dirname(env.folder), "outside-"));
  try {
    fs.writeFileSync(path.join(outside, "canvas.json"), JSON.stringify({ title: "Not yours", boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } } }), "utf8");
    env.write("Main.html", "<main>Cart</main>");
    fs.symlinkSync(path.join(outside, "canvas.json"), path.join(env.folder, "canvas.json"));
    const before = env.canvasStore.getById(env.canvas.id)!;
    expect(env.canvasStore.publishSource(env.canvas.id).error).toBe("canvas.json is outside the canvas folder.");
    const after = env.canvasStore.getById(env.canvas.id)!;
    expect(after.title).toBe(before.title);
    expect(after.contentRevision).toBe(before.contentRevision);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    env.cleanup();
  }
});

test("an artboard reached through a symlink out of the canvas folder is refused", () => {
  const env = designEnv("md-design-symlink-");
  const outside = fs.mkdtempSync(path.join(path.dirname(env.folder), "outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.html"), "<p>not yours</p>", "utf8");
    env.write("canvas.json", JSON.stringify({ boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } } }));
    fs.symlinkSync(path.join(outside, "secret.html"), path.join(env.folder, "Main.html"));
    expect(env.canvasStore.publishSource(env.canvas.id).error).toBe('"Main.html" is outside the canvas folder.');
    fs.rmSync(path.join(env.folder, "Main.html"));
    env.write("canvas.json", JSON.stringify({ boards: { "linked/Main.html": { x: 0, y: 0, w: 390, h: 844 } } }));
    fs.writeFileSync(path.join(outside, "Main.html"), "<p>not yours</p>", "utf8");
    fs.symlinkSync(outside, path.join(env.folder, "linked"));
    expect(env.canvasStore.publishSource(env.canvas.id).error).toBe('"linked/Main.html" is outside the canvas folder.');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    env.cleanup();
  }
});
