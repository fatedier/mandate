import type { Hono } from "hono";
import { API_ROUTES } from "../../../shared/api/routes.js";
import { IMAGE_MAX_BYTES, type FileError, type SharedFileSaved } from "../../../shared/api/files.js";
import { fileKindOf, readFileDto } from "./file-read.js";
import { resolveAllowed, type FileRootsDeps } from "./file-roots.js";
import { saveUnderFreeName } from "./share-file-save.js";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface FileRoutesDeps extends FileRootsDeps {
  /** The user's Downloads folder, where the desktop app's saves go (made when missing). */
  downloadsDir: string;
}

const RAW_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf"
};

/** `Content-Disposition` for a file saved under its own name: an ASCII
 *  stand-in for old clients, the exact name (RFC 6266) for the rest. */
function attachmentOf(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * as they are; an extended value may not
  // hold them (RFC 5987 attr-char), and a browser then drops the exact name.
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

/** A file an agent linked: its facts and text, an image's or a PDF's bytes,
 *  and any file to keep (downloaded, or for the desktop app, copied into
 *  Downloads). Read only, and only inside the allowed folders (file-roots). */
export function mountFileRoutes(app: Hono, deps: FileRoutesDeps): void {
  app.get(API_ROUTES.files, (c) => {
    c.header("Cache-Control", "no-store");
    const found = resolveAllowed(c.req.query("path") ?? "", deps);
    if ("code" in found) return c.json({ error: found.error, code: found.code } satisfies FileError, found.status);
    const part = c.req.query("part");
    const line = Number(c.req.query("line"));
    return c.json(readFileDto(found, {
      ...(part === "start" || part === "end" ? { part } : {}),
      ...(Number.isInteger(line) && line >= 1 ? { line } : {})
    }));
  });

  app.get(API_ROUTES.fileRaw, (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const found = resolveAllowed(c.req.query("path") ?? "", deps);
    if ("code" in found) return c.json({ error: found.error, code: found.code } satisfies FileError, found.status);
    const kind = fileKindOf(found.requested, headOf(found.real));
    if (kind !== "image" && kind !== "pdf") return c.json({ error: "only images and PDFs are served", code: "invalid" } satisfies FileError, 400);
    if (kind === "image" && found.stat.size > IMAGE_MAX_BYTES) return c.json({ error: "the image is too large", code: "too_large" } satisfies FileError, 413);
    // An image opened on its own (an SVG) runs no script on Mandate's origin,
    // which has no login. A PDF keeps the browser's own viewer.
    if (kind === "image") c.header("Content-Security-Policy", "sandbox");
    // The type the name says, which the checks above went by: a link named
    // .pdf to a page is never sent as a page (it would run on Mandate's origin).
    c.header("Content-Type", RAW_TYPES[path.extname(found.requested).toLowerCase()] ?? "application/octet-stream");
    return new Response(Bun.file(found.real), { headers: c.res.headers });
  });

  // Bytes to save, never a page: whatever the file is, the browser is told
  // to keep it (an attachment of no type it may guess past), so nothing in
  // it runs on Mandate's origin. No sandbox policy: Chromium then drops the
  // file's name and saves it as "download".
  app.get(API_ROUTES.fileDownload, (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const found = resolveAllowed(c.req.query("path") ?? "", deps);
    if ("code" in found) return c.json({ error: found.error, code: found.code } satisfies FileError, found.status);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", attachmentOf(path.basename(found.requested)));
    return new Response(Bun.file(found.real), { headers: c.res.headers });
  });

  // The desktop app's webview downloads nothing: a copy goes into Downloads
  // under the file's own name, never over a file there.
  app.post(API_ROUTES.fileSave, async (c) => {
    const body = await c.req.json().catch(() => null) as { path?: unknown } | null;
    const raw = typeof body?.path === "string" ? body.path : "";
    const found = resolveAllowed(raw, deps);
    if ("code" in found) return c.json({ error: found.error, code: found.code } satisfies FileError, found.status);
    const name = path.basename(found.requested);
    const ext = path.extname(name);
    const file = await saveUnderFreeName(deps.downloadsDir, name.slice(0, name.length - ext.length), ext,
      (to) => fsp.copyFile(found.real, to, fs.constants.COPYFILE_EXCL));
    return file ? c.json({ path: file } satisfies SharedFileSaved) : c.json({ error: "no free name to save under", code: "invalid" } satisfies FileError, 409);
  });
}

function headOf(real: string): Uint8Array {
  // The extension decides an image or a PDF; the head is only for the rest.
  const fd = fs.openSync(real, "r");
  try {
    const buffer = Buffer.alloc(8 * 1024);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}
