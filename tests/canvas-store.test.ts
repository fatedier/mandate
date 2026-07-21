import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { freshAgentEnv, freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("CanvasStore creates, updates, and records events", () => {
  const { dir, store, agentStore, cleanup } = freshAgentEnv("md-canvas-");
  try {
    const canvasStore = new CanvasStore(store.db, dir);
    const thread = agentStore.getOrCreateThread("manager", null);

    const created = canvasStore.create({
      title: "Plan",
      scope: "manager",
      scopeId: null,
      threadId: thread.id
    });

    expect(created.title).toBe("Plan");
    expect(created.kind).toBe("html");
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
      "content_revision"
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

    canvasStore.appendEvent({
      canvasId: created.id,
      threadId: thread.id,
      action: "approve",
      data: { ok: true }
    });
    const row = store.db.prepare(
      "select action, data_json from canvas_events where canvas_id = ?"
    ).get(created.id) as { action: string; data_json: string };
    expect(row.action).toBe("approve");
    expect(JSON.parse(row.data_json)).toEqual({ ok: true });
  } finally {
    cleanup();
  }
});

test("CanvasStore lists feature canvases without html and with navigation context", () => {
  const { dir, store, projects, features, agentStore, cleanup } = freshStoresEnv("md-canvas-list-");
  try {
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
      kind: "html",
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
      kind: "html",
      projectId,
      projectName: "Mandate",
      projectSlug: "md-mandate",
      featureId,
      featureName: "Canvas browser",
      featureSlug: "canvas_browser"
    });
  } finally {
    cleanup();
  }
});
