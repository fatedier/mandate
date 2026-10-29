import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { mountCanvasRoutes } from "../src/server/modules/canvas/canvas-routes.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { getJson } from "./helpers/test-app.js";
import { stub } from "./helpers/typed.js";
import type { AppDeps } from "../src/server/app/deps.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";


/** Makes one fs call fail on one path as a permission denial does — whoever
 *  runs the tests: root ignores chmod. Returns the undo. */
function denied(name: "rmSync" | "realpathSync", target: string): () => void {
  const original = fs[name] as (...args: unknown[]) => unknown;
  const spy = spyOn(fs, name).mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (String(p) === target) throw Object.assign(new Error(`EACCES: permission denied, ${name} '${target}'`), { code: "EACCES" });
    return original(p, ...rest);
  }) as never);
  return () => spy.mockRestore();
}

test("GET /api/features/:id/canvases lists only that Worker's canvases without html", async () => {
  const env = freshStoresEnv("md-canvas-routes-");
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
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));

  const result = await getJson(app, `/api/features/${featureId}/canvases`);
  expect(result.status).toBe(200);
  expect(result.body.canvases).toHaveLength(1);
  expect(result.body.canvases[0]).toMatchObject({
    id: canvas.id,
    title: "Status board",
    kind: "report",
    scope: "worker",
    scopeId: featureId,
    threadId: thread.id
  });
  expect("html" in result.body.canvases[0]).toBe(false);
  expect((await app.request("/api/canvas")).status).toBe(404);
});

test("GET /api/canvas/:id returns feature navigation context", async () => {
  const env = freshStoresEnv("md-canvas-routes-detail-");
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
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));

  const result = await getJson(app, `/api/canvas/${encodeURIComponent(canvas.id)}`);
  expect(result.status).toBe(200);
  expect(result.body.canvas).toMatchObject({
    id: canvas.id,
    title: "Feature plan",
    kind: "report",
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
});

test("the report-to-agent events route is gone", async () => {
  const env = freshStoresEnv("md-canvas-routes-event-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const a = env.agentStore.createManagerThread("A");
  const canvas = canvasStore.create({ title: "A's canvas", scope: "manager", scopeId: null, threadId: a.id });
  const app = new Hono();
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));
  const res = await app.request(`/api/canvas/${canvas.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", data: {} })
  });
  expect(res.status).toBe(404);
});

test("Canvas documents revalidate with weak tags, lists and HEAD without caching missing documents", async () => {
  const env = freshStoresEnv("md-canvas-routes-cache-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Cached", scope: "manager", scopeId: null, threadId: thread.id });
  const app = new Hono();
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));
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
});

test("GET /api/canvas/:id/assets/* serves files beside the canvas source", async () => {
  const env = freshStoresEnv("md-canvas-routes-assets-");
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
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));

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
});

test("Canvas asset validators detect same-size edits, atomic replacement and deletion", async () => {
  const env = freshStoresEnv("md-canvas-routes-asset-cache-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Assets", scope: "manager", scopeId: null, threadId: thread.id });
  const filename = path.join(path.dirname(canvas.filePath!), "data.txt");
  fs.writeFileSync(filename, "old");
  const originalTime = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(filename, originalTime, originalTime);
  const app = new Hono();
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));
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
});

test("GET /api/canvas/:id/assets/* rejects paths outside the canvas directory", async () => {
  const env = freshStoresEnv("md-canvas-routes-assets-escape-");
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
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));

  const response = await app.request(
    `/api/canvas/${encodeURIComponent(canvas.id)}/assets/..%2Fsecret.txt`
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "canvas asset path is outside the canvas directory" });
});

test("a report's own files are served sandboxed, a revalidated one too, so an HTML file opened in its own tab cannot use Mandate's origin", async () => {
  const env = freshStoresEnv("md-canvas-routes-assets-sandbox-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Preview", scope: "manager", scopeId: null, threadId: thread.id });
  fs.writeFileSync(path.join(path.dirname(canvas.filePath!), "details.html"), "<script>fetch('/api/state')</script>");
  const app = new Hono();
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));
  const url = `/api/canvas/${encodeURIComponent(canvas.id)}/assets/details.html`;
  const response = await app.request(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  const cached = await app.request(url, { headers: { "If-None-Match": response.headers.get("ETag")! } });
  expect(cached.status).toBe(304);
  expect(cached.headers.get("Content-Security-Policy")).toBe("sandbox");
  expect(cached.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("DELETE /api/canvas/:id removes the canvas and its folder, says so to every open page, and 404s after", async () => {
  const env = freshStoresEnv("md-canvas-routes-delete-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const projectId = seedProject(env.projects);
  const featureId = seedFeature(env.features, projectId);
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  const doomed = canvasStore.create({ title: "Old report", scope: "worker", scopeId: featureId, threadId: thread.id, projectId });
  const kept = canvasStore.create({ title: "Current report", scope: "worker", scopeId: featureId, threadId: thread.id, projectId });
  for (const c of [doomed, kept]) {
    fs.writeFileSync(c.filePath!, "<p>page</p>");
    fs.writeFileSync(path.join(path.dirname(c.filePath!), "chart.svg"), "<svg/>");
  }
  const emitted: Array<{ event: string; data: unknown }> = [];
  const app = new Hono();
  const sse = stub<AgentSseEmitter>({ emit: ((event: string, data: unknown) => { emitted.push({ event, data }); }) as AgentSseEmitter["emit"] });
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore, sse }));

  const res = await app.request(`/api/canvas/${doomed.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(canvasStore.getById(doomed.id)).toBeNull();
  expect(fs.existsSync(path.dirname(doomed.filePath!))).toBe(false);
  // Its neighbour, in the same canvases folder, is untouched.
  expect(canvasStore.getById(kept.id)).not.toBeNull();
  expect(fs.readFileSync(path.join(path.dirname(kept.filePath!), "chart.svg"), "utf8")).toBe("<svg/>");
  expect(emitted).toStrictEqual([{ event: "canvasUpdated", data: { canvasId: doomed.id, featureId } }]);

  const again = await app.request(`/api/canvas/${doomed.id}`, { method: "DELETE" });
  expect(again.status).toBe(404);
  expect(emitted).toHaveLength(1);
});

test("deleting a canvas whose file lies outside its own folder removes the row and no file", () => {
  const env = freshStoresEnv("md-canvas-delete-outside-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Odd", scope: "manager", scopeId: null, threadId: manager.id });
  const decoyDir = path.join(env.dir, "elsewhere");
  fs.mkdirSync(decoyDir);
  const decoy = path.join(decoyDir, "index.html");
  fs.writeFileSync(decoy, "keep me");
  env.store.db.prepare("update canvas_documents set file_path = ? where id = ?").run(decoy, canvas.id);

  expect(canvasStore.delete(canvas.id)?.id).toBe(canvas.id);
  expect(canvasStore.getById(canvas.id)).toBeNull();
  expect(fs.readFileSync(decoy, "utf8")).toBe("keep me");
  expect(canvasStore.delete("cnv_missing")).toBeNull();
});

test("a canvases folder that is a symlink elsewhere is never followed: nothing outside the resources tree is removed", () => {
  const env = freshStoresEnv("md-canvas-delete-symlink-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Linked", scope: "manager", scopeId: null, threadId: manager.id });
  fs.writeFileSync(canvas.filePath!, "<p>page</p>");
  // The bucket moves out of the tree and a symlink takes its place.
  const bucket = path.dirname(path.dirname(canvas.filePath!));
  const outside = path.join(env.dir, "outside-canvases");
  fs.renameSync(bucket, outside);
  fs.symlinkSync(outside, bucket);
  canvasStore.delete(canvas.id);
  expect(fs.readFileSync(path.join(outside, canvas.id, "index.html"), "utf8")).toBe("<p>page</p>");
});

test("a folder that cannot be removed keeps the canvas, so deleting can be tried again", () => {
  const env = freshStoresEnv("md-canvas-delete-readonly-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Stuck", scope: "manager", scopeId: null, threadId: manager.id });
  fs.writeFileSync(canvas.filePath!, "<p>page</p>");
  const undo = denied("rmSync", path.dirname(canvas.filePath!));
  try {
    expect(() => canvasStore.delete(canvas.id)).toThrow("could not remove");
    expect(canvasStore.getById(canvas.id)?.id).toBe(canvas.id);
    undo();
    expect(canvasStore.delete(canvas.id)?.id).toBe(canvas.id);
    expect(fs.existsSync(path.dirname(canvas.filePath!))).toBe(false);
  } finally {
    undo();
    env.cleanup();
  }
});

test("a worker canvas made without a project id has its files removed from where they were made", () => {
  const env = freshStoresEnv("md-canvas-delete-noproject-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const projectId = seedProject(env.projects);
  const featureId = seedFeature(env.features, projectId);
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  // No projectId: the files go under the global bucket, though the feature has a project.
  const canvas = canvasStore.create({ title: "Unowned", scope: "worker", scopeId: featureId, threadId: thread.id });
  fs.writeFileSync(canvas.filePath!, "<p>page</p>");
  expect(canvasStore.delete(canvas.id)?.id).toBe(canvas.id);
  expect(fs.existsSync(path.dirname(canvas.filePath!))).toBe(false);
});

test("DELETE answers 500 with the reason when the folder cannot be removed, and the canvas stays", async () => {
  const env = freshStoresEnv("md-canvas-routes-delete-500-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Stuck", scope: "manager", scopeId: null, threadId: manager.id });
  fs.writeFileSync(canvas.filePath!, "<p>page</p>");
  const undo = denied("rmSync", path.dirname(canvas.filePath!));
  try {
    const emitted: unknown[] = [];
    const app = new Hono();
    const sse = stub<AgentSseEmitter>({ emit: ((event: string) => { emitted.push(event); }) as AgentSseEmitter["emit"] });
    mountCanvasRoutes(app, stub<AppDeps>({ canvasStore, sse }));
    const res = await app.request(`/api/canvas/${canvas.id}`, { method: "DELETE" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("could not remove");
    expect(canvasStore.getById(canvas.id)?.id).toBe(canvas.id);
    expect(emitted).toStrictEqual([]);
  } finally {
    undo();
    env.cleanup();
  }
});

test("a file elsewhere inside the resources tree is no canvas folder: deleting the canvas leaves that folder", () => {
  const env = freshStoresEnv("md-canvas-delete-inside-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Pointed elsewhere", scope: "manager", scopeId: null, threadId: manager.id });
  // A thread's saved tool outputs, in the same resources tree.
  const outputs = path.join(env.dir, "resources", "global", "tool-output", "thr_1");
  fs.mkdirSync(outputs, { recursive: true });
  fs.writeFileSync(path.join(outputs, "saved.txt"), "keep me");
  env.store.db.prepare("update canvas_documents set file_path = ? where id = ?").run(path.join(outputs, "saved.txt"), canvas.id);
  expect(canvasStore.delete(canvas.id)?.id).toBe(canvas.id);
  expect(fs.readFileSync(path.join(outputs, "saved.txt"), "utf8")).toBe("keep me");
});

test("a canvases folder that cannot be searched keeps the canvas: only a folder that is not there needs no removing", () => {
  const env = freshStoresEnv("md-canvas-delete-nosearch-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const canvas = canvasStore.create({ title: "Hidden", scope: "manager", scopeId: null, threadId: manager.id });
  fs.writeFileSync(canvas.filePath!, "<p>page</p>");
  const undo = denied("realpathSync", path.dirname(canvas.filePath!));
  try {
    expect(() => canvasStore.delete(canvas.id)).toThrow("could not remove");
    expect(canvasStore.getById(canvas.id)?.id).toBe(canvas.id);
    expect(fs.existsSync(canvas.filePath!)).toBe(true);
  } finally {
    undo();
    env.cleanup();
  }
});

test("GET /api/canvases/titles answers the titles of the canvases asked for, and nothing of the rest", async () => {
  const env = freshStoresEnv("md-canvas-titles-");
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const report = canvasStore.create({ title: "Release notes", scope: "manager", scopeId: null, threadId: thread.id });
  const design = canvasStore.create({ title: "Test Connection 带参数设计", kind: "design", scope: "manager", scopeId: null, threadId: thread.id });
  const app = new Hono();
  mountCanvasRoutes(app, stub<AppDeps>({ canvasStore }));
  const ask = (ids: string) => getJson(app, `/api/canvases/titles?ids=${encodeURIComponent(ids)}`);
  // Ones that are not there, or are not a canvas's id, are left out.
  const answer = await ask([report.id, design.id, "cnv_00000000000", "../etc", report.id].join(","));
  expect(answer.status).toBe(200);
  expect(answer.body.canvases.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))).toEqual(
    [{ id: report.id, title: "Release notes", kind: "report" }, { id: design.id, title: "Test Connection 带参数设计", kind: "design" }].sort((a, b) => a.id.localeCompare(b.id))
  );
  expect((await ask("")).body).toEqual({ canvases: [] });
  // At most 50 at once.
  const many = Array.from({ length: 51 }, (_, i) => `cnv_${String(i).padStart(11, "0")}`).join(",");
  expect((await ask(many)).status).toBe(400);
  env.cleanup();
});
