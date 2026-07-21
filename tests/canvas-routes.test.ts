import { expect, test } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { mountCanvasRoutes } from "../src/server/modules/canvas/canvas-routes.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { getJson } from "./helpers/test-app.js";

test("GET /api/features/:id/canvases lists only that Worker's canvases without html", async () => {
  const env = freshStoresEnv("md-canvas-routes-");
  try {
    const canvasStore = new CanvasStore(env.store.db, env.dir);
    const projectId = seedProject(env.projects);
    const featureId = seedFeature(env.features, projectId);
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    const canvas = canvasStore.create({
      title: "Status board",
      scope: "worker",
      scopeId: featureId,
      threadId: thread.id
    });
    const manager = env.agentStore.getOrCreateThread("manager", null);
    canvasStore.create({ title: "Manager canvas", scope: "manager", scopeId: null, threadId: manager.id });

    const app = new Hono();
    mountCanvasRoutes(app, { ...env, canvasStore } as any);

    const result = await getJson(app, `/api/features/${featureId}/canvases`);
    expect(result.status).toBe(200);
    expect(result.body.canvases).toHaveLength(1);
    expect(result.body.canvases[0]).toMatchObject({
      id: canvas.id,
      title: "Status board",
      kind: "html",
      scope: "worker",
      scopeId: featureId,
      threadId: thread.id
    });
    expect("html" in result.body.canvases[0]).toBe(false);
    expect((await app.request("/api/canvas")).status).toBe(404);
  } finally {
    env.cleanup();
  }
});

test("GET /api/canvas/:id returns feature navigation context", async () => {
  const env = freshStoresEnv("md-canvas-routes-detail-");
  try {
    const canvasStore = new CanvasStore(env.store.db, env.dir);
    const projectId = seedProject(env.projects, {
      name: "Mandate",
      tmuxSessionName: "md-mandate"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "Canvas browser",
      tmuxWindowName: "canvas_browser"
    });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    const canvas = canvasStore.create({
      title: "Feature plan",
      scope: "worker",
      scopeId: featureId,
      threadId: thread.id,
      projectId
    });

    const app = new Hono();
    mountCanvasRoutes(app, { ...env, canvasStore } as any);

    const result = await getJson(app, `/api/canvas/${encodeURIComponent(canvas.id)}`);
    expect(result.status).toBe(200);
    expect(result.body.canvas).toMatchObject({
      id: canvas.id,
      title: "Feature plan",
      kind: "html",
      projectId,
      projectName: "Mandate",
      projectSlug: "md-mandate",
      featureId,
      featureName: "Canvas browser",
      featureSlug: "canvas_browser"
    });

    const url = `/api/canvas/${encodeURIComponent(canvas.id)}`;
    let response = await app.request(url);
    let etag = response.headers.get("ETag")!;
    const updatedAt = result.body.canvas.updatedAt;
    // These changes do not advance the Canvas timestamp.
    for (const [sql, value, id, field] of [
      ["update canvas_documents set html = ? where id = ?", "<p>Updated</p>", canvas.id, "html"],
      ["update canvas_documents set title = ? where id = ?", "New title", canvas.id, "title"],
      ["update projects set name = ? where id = ?", "Renamed project", projectId, "projectName"],
      ["update features set name = ? where id = ?", "Renamed feature", featureId, "featureName"]
    ] as const) {
      env.store.db.prepare(sql).run(value, id);
      response = await app.request(url, { headers: { "If-None-Match": etag } });
      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).not.toBe(etag);
      expect((await response.json()).canvas).toMatchObject({ [field]: value, updatedAt });
      etag = response.headers.get("ETag")!;
    }
  } finally {
    env.cleanup();
  }
});

test("Canvas documents revalidate with weak tags, lists and HEAD without caching missing documents", async () => {
  const env = freshStoresEnv("md-canvas-routes-cache-");
  try {
    const canvasStore = new CanvasStore(env.store.db, env.dir);
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const canvas = canvasStore.create({ title: "Cached", scope: "manager", scopeId: null, threadId: thread.id });
    const app = new Hono();
    mountCanvasRoutes(app, { ...env, canvasStore } as any);
    const url = `/api/canvas/${canvas.id}`;
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    const etag = response.headers.get("ETag")!;
    expect(etag).toStartWith('W/"');
    const original = await response.text();
    for (const method of ["GET", "HEAD"]) {
      for (const condition of [etag, etag.slice(2), `"old", ${etag}`, "*"]) {
        const cached = await app.request(url, { method, headers: { "If-None-Match": condition } });
        expect(cached.status).toBe(304);
        expect(await cached.text()).toBe("");
        expect(cached.headers.get("ETag")).toBe(etag);
        expect(cached.headers.get("Cache-Control")).toBe("private, no-cache");
      }
    }
    const changed = await app.request(url, { headers: { "If-None-Match": 'W/"old"' } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe(original);
    const missing = await app.request("/api/canvas/missing", { headers: { "If-None-Match": "*" } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(missing.headers.get("ETag")).toBeNull();
  } finally { env.cleanup(); }
});

test("GET /api/canvas/:id/assets/* serves files beside the canvas source", async () => {
  const env = freshStoresEnv("md-canvas-routes-assets-");
  try {
    const canvasStore = new CanvasStore(env.store.db, env.dir);
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const canvas = canvasStore.create({
      title: "Preview",
      scope: "manager",
      scopeId: null,
      threadId: thread.id
    });
    const sourceDir = path.dirname(canvas.filePath!);
    const previewDir = path.join(sourceDir, "preview");
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, "page.png"), "png-bytes");

    const app = new Hono();
    mountCanvasRoutes(app, { ...env, canvasStore } as any);

    const response = await app.request(`/api/canvas/${encodeURIComponent(canvas.id)}/assets/preview/page.png`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png-bytes");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("Content-Type")).toStartWith("image/png");
    const etag = response.headers.get("ETag")!;
    expect(etag).toStartWith('W/"');
    const cached = await app.request(`/api/canvas/${encodeURIComponent(canvas.id)}/assets/preview/page.png`, {
      headers: { "If-None-Match": etag }
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("ETag")).toBe(etag);
    expect(cached.headers.get("Cache-Control")).toBe("private, no-cache");
  } finally {
    env.cleanup();
  }
});

test("Canvas asset validators detect same-size edits, atomic replacement and deletion", async () => {
  const env = freshStoresEnv("md-canvas-routes-asset-cache-");
  try {
    const canvasStore = new CanvasStore(env.store.db, env.dir);
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const canvas = canvasStore.create({ title: "Assets", scope: "manager", scopeId: null, threadId: thread.id });
    const filename = path.join(path.dirname(canvas.filePath!), "data.txt");
    fs.writeFileSync(filename, "old");
    const originalTime = new Date("2026-01-01T00:00:00.000Z");
    fs.utimesSync(filename, originalTime, originalTime);
    const app = new Hono();
    mountCanvasRoutes(app, { ...env, canvasStore } as any);
    const url = `/api/canvas/${canvas.id}/assets/data.txt`;
    let response = await app.request(url);
    let etag = response.headers.get("ETag")!;
    expect(await response.text()).toBe("old");

    fs.writeFileSync(filename, "new");
    fs.utimesSync(filename, originalTime, originalTime);
    response = await app.request(url, { headers: { "If-None-Match": etag } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("new");
    expect(response.headers.get("ETag")).not.toBe(etag);
    etag = response.headers.get("ETag")!;

    fs.writeFileSync(`${filename}.new`, "end");
    fs.utimesSync(`${filename}.new`, originalTime, originalTime);
    fs.renameSync(`${filename}.new`, filename);
    response = await app.request(url, { headers: { "If-None-Match": etag } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("end");
    expect(response.headers.get("ETag")).not.toBe(etag);
    etag = response.headers.get("ETag")!;

    fs.unlinkSync(filename);
    response = await app.request(url, { headers: { "If-None-Match": etag } });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("ETag")).toBeNull();
  } finally { env.cleanup(); }
});

test("GET /api/canvas/:id/assets/* rejects paths outside the canvas directory", async () => {
  const env = freshStoresEnv("md-canvas-routes-assets-escape-");
  try {
    const canvasStore = new CanvasStore(env.store.db, env.dir);
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const canvas = canvasStore.create({
      title: "Preview",
      scope: "manager",
      scopeId: null,
      threadId: thread.id
    });
    fs.writeFileSync(path.join(path.dirname(canvas.filePath!), "..", "secret.txt"), "secret");

    const app = new Hono();
    mountCanvasRoutes(app, { ...env, canvasStore } as any);

    const response = await app.request(
      `/api/canvas/${encodeURIComponent(canvas.id)}/assets/..%2Fsecret.txt`
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "canvas asset path is outside the canvas directory" });
  } finally {
    env.cleanup();
  }
});
