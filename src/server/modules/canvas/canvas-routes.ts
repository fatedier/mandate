import type { Context, Hono } from "hono";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  API_ROUTES,
  SSE_EVENTS,
  type CanvasDocumentResponse,
  type CanvasEventRequest,
  type CanvasEventResponse,
  type FeatureCanvasesResponse
} from "../../../shared/api-contracts.js";
import type { AppDeps } from "../../app/deps.js";

const MAX_ACTION_LENGTH = 80;
const MAX_EVENT_JSON_BYTES = 32 * 1024;

export function mountCanvasRoutes(app: Hono, deps: AppDeps): void {
  app.get(API_ROUTES.featureCanvases, (c) => {
    const canvases = deps.canvasStore.listForFeature(c.req.param("id"));
    return c.json({ canvases } satisfies FeatureCanvasesResponse);
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

  app.get(API_ROUTES.canvasAssets, (c) => {
    c.header("Cache-Control", "no-store");
    const canvas = deps.canvasStore.getById(c.req.param("id"));
    if (!canvas) return c.json({ error: "canvas not found" }, 404);
    if (!canvas.filePath) return c.json({ error: "canvas has no source file" }, 404);

    const resolved = resolveCanvasAssetPath(canvas.filePath, c.req.param("assetPath"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);

    // Nanosecond change time and inode also catch same-size edits with a
    // preserved mtime, and atomic replacement. Keep large assets streaming.
    const { stat } = resolved;
    const etag = `W/"${stat.ino.toString(16)}-${stat.size.toString(16)}-${stat.mtimeNs.toString(16)}-${stat.ctimeNs.toString(16)}"`;
    if (canvasNotModified(c, etag)) return c.body(null, 304);
    const file = Bun.file(resolved.path);
    if (file.type) c.header("Content-Type", file.type);
    return new Response(file, { headers: c.res.headers });
  });

  app.post(API_ROUTES.canvasEvents, async (c) => {
    const canvas = deps.canvasStore.getById(c.req.param("id"));
    if (!canvas) return c.json({ error: "canvas not found" } satisfies CanvasEventResponse, 404);

    let body: CanvasEventRequest;
    try {
      body = await c.req.json() as CanvasEventRequest;
    } catch {
      return c.json({ error: "invalid JSON" } satisfies CanvasEventResponse, 400);
    }

    const action = normalizeAction(body.action);
    if (!action) return c.json({ error: "action is required" } satisfies CanvasEventResponse, 400);
    const data = body.data ?? {};
    const eventJson = safeJson(data);
    if (Buffer.byteLength(eventJson, "utf8") > MAX_EVENT_JSON_BYTES) {
      return c.json({ error: "canvas event payload is too large" } satisfies CanvasEventResponse, 400);
    }

    const thread = deps.agentStore.getThreadById(canvas.threadId);
    if (!thread) return c.json({ error: "agent thread not found" } satisfies CanvasEventResponse, 404);
    const threadError = validateCanvasEventThread(thread);
    if (threadError) {
      return c.json({ error: threadError.error } satisfies CanvasEventResponse, threadError.status);
    }

    deps.canvasStore.appendEvent({
      canvasId: canvas.id,
      threadId: canvas.threadId,
      action,
      data
    });

    const text = renderCanvasEventMessage(canvas.title, action, eventJson);

    if (deps.userMessageQueue) {
      const result = deps.userMessageQueue.submitUserMessage({
        scope: thread.scope,
        scopeId: thread.scopeId,
        content: text
      });
      return c.json({ ok: true, ...result } satisfies CanvasEventResponse, 202);
    }

    const message = deps.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text }
    });
    deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: thread.id, message });
    const wakeId = deps.wakeScheduler.wake(thread.id, "user", message.id);
    return c.json({
      ok: true,
      threadId: thread.id,
      messageId: message.id,
      wakeId
    } satisfies CanvasEventResponse, 202);
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

function validateCanvasEventThread(thread: { archivedAt: string | null }): {
  error: string;
  status: 410;
} | null {
  if (thread.archivedAt) {
    return { error: "canvas agent thread is archived", status: 410 };
  }
  return null;
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

function normalizeAction(action: unknown): string | null {
  if (typeof action !== "string") return null;
  const trimmed = action.trim();
  if (!trimmed || trimmed.length > MAX_ACTION_LENGTH) return null;
  return trimmed;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return JSON.stringify(String(value));
  }
}

function renderCanvasEventMessage(title: string, action: string, json: string): string {
  return [
    `The user submitted the canvas "${title}".`,
    "",
    `Action: ${action}`,
    "",
    "Submitted data:",
    "```json",
    json,
    "```"
  ].join("\n");
}
