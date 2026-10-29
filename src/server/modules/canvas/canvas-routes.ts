import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  API_ROUTES,
  CANVAS_ID,
  CANVAS_TITLES_MAX,
  SSE_EVENTS,
  type CanvasDocumentResponse,
  type CanvasTitlesResponse,
  type DeleteCanvasResponse,
  type FeatureCanvasesResponse,
  type ThreadCanvasesResponse
} from "../../../shared/api-contracts.js";
import type { AppDeps } from "../../app/deps.js";
import { errorText } from "../../../shared/error-text.js";

export function mountCanvasRoutes(app: Hono, deps: AppDeps): void {
  app.get(API_ROUTES.featureCanvases, (c) => {
    const canvases = deps.canvasStore.listForFeature(c.req.param("id"));
    return c.json({ canvases } satisfies FeatureCanvasesResponse);
  });

  app.get(API_ROUTES.agentManagerThreadCanvases, (c) => {
    const threadId = c.req.param("threadId");
    const featureIds = [...deps.features.listActiveOwnedBy(threadId), ...deps.features.listArchivedOwnedBy(threadId)].map((f) => f.id);
    const canvases = deps.canvasStore.listForThread(threadId, featureIds);
    return c.json({ canvases } satisfies ThreadCanvasesResponse);
  });

  // Ids not shaped as a canvas's are left out: they name no canvas.
  app.get(API_ROUTES.canvasTitles, (c) => {
    const ids = [...new Set((c.req.query("ids") ?? "").split(",").map((id) => id.trim()).filter((id) => CANVAS_ID.test(id)))];
    if (ids.length > CANVAS_TITLES_MAX) return c.json({ error: `at most ${CANVAS_TITLES_MAX} canvases at once` } satisfies CanvasTitlesResponse, 400);
    return c.json({ canvases: deps.canvasStore.titlesOf(ids) } satisfies CanvasTitlesResponse);
  });

  app.get(API_ROUTES.canvasById, (c) => {
    c.header("Cache-Control", "no-store");
    const canvas = deps.canvasStore.getById(c.req.param("id"));
    if (!canvas) return c.json({ error: "canvas not found" } satisfies CanvasDocumentResponse, 404);
    // Include HTML and joined navigation metadata, which can change without
    // advancing the Canvas timestamp. Serialize once for both hashing and JSON.
    const body = JSON.stringify({ canvas } satisfies CanvasDocumentResponse);
    const etag = `W/"${createHash("sha256").update(body).digest("hex")}"`;
    if (canvasNotModified(c, etag)) return c.body(null, 304);
    return c.body(body, 200, { "Content-Type": "application/json" });
  });

  // Only a person deletes a canvas, from the app: agents have no tool for it.
  app.delete(API_ROUTES.canvasById, (c) => {
    let deleted;
    try {
      deleted = deps.canvasStore.delete(c.req.param("id"));
    } catch (err) {
      // Its files could not be removed: the canvas stays, to try again.
      return c.json({ error: errorText(err) } satisfies DeleteCanvasResponse, 500);
    }
    if (!deleted) return c.json({ error: "canvas not found" } satisfies DeleteCanvasResponse, 404);
    // Lists refetch without it, and an open view of it finds it gone.
    deps.sse.emit(SSE_EVENTS.canvasUpdated, { canvasId: deleted.id, featureId: deleted.scope === "worker" ? deleted.scopeId : null });
    return c.json({ ok: true } satisfies DeleteCanvasResponse);
  });

  app.get(API_ROUTES.canvasAssets, (c) => {
    c.header("Cache-Control", "no-store");
    const canvas = deps.canvasStore.getById(c.req.param("id"));
    if (!canvas) return c.json({ error: "canvas not found" }, 404);

    const resolved = resolveCanvasAssetPath(canvas.filePath, c.req.param("assetPath"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);

    // Nanosecond change time and inode also catch same-size edits with a
    // preserved mtime, and atomic replacement. Keep large assets streaming.
    const { stat } = resolved;
    const etag = `W/"${stat.ino.toString(16)}-${stat.size.toString(16)}-${stat.mtimeNs.toString(16)}-${stat.ctimeNs.toString(16)}"`;
    // A report links to its own files, and links open in a new tab outside the
    // viewer's sandbox. Served from Mandate's origin, an HTML file there could
    // then drive Mandate's API (it has no auth), so every file is sandboxed:
    // an opaque origin, no scripts, no forms. Set before the 304 too, or a
    // copy cached before this header existed would be reused without it.
    // Images, scripts and styles loaded by the report ignore it.
    c.header("Content-Security-Policy", "sandbox");
    c.header("X-Content-Type-Options", "nosniff");
    if (canvasNotModified(c, etag)) return c.body(null, 304);
    const file = Bun.file(resolved.path);
    if (file.type) c.header("Content-Type", file.type);
    return new Response(file, { headers: c.res.headers });
  });
}

function canvasNotModified(c: Context, etag: string): boolean {
  c.header("Cache-Control", "private, no-cache");
  c.header("ETag", etag);
  // Preserve the same cache dimensions on 200 and bodyless 304 responses,
  // including when the outer JSON compression middleware has nothing to read.
  c.header("Vary", "Accept-Encoding");
  const condition = c.req.header("If-None-Match");
  const opaqueTag = etag.replace(/^W\//, "");
  return condition?.trim() === "*" ||
    (condition?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === opaqueTag) ?? false);
}


function resolveCanvasAssetPath(
  canvasFilePath: string,
  rawAssetPath: string | undefined
): { path: string; stat: fs.BigIntStats } | { error: string; status: 400 | 403 | 404 } {
  const assetPath = decodeAssetPath(rawAssetPath ?? "");
  if (!assetPath || assetPath.includes("\0") || assetPath.includes("\\") || assetPath.startsWith("/")) {
    return { error: "invalid canvas asset path", status: 400 };
  }

  const root = path.resolve(path.dirname(canvasFilePath));
  const target = path.resolve(root, assetPath);
  if (!isPathInside(target, root)) {
    return { error: "canvas asset path is outside the canvas directory", status: 403 };
  }

  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(target, { bigint: true });
  } catch {
    return { error: "canvas asset not found", status: 404 };
  }
  if (!stat.isFile()) return { error: "canvas asset not found", status: 404 };
  return { path: target, stat };
}

function decodeAssetPath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}



