import type { Hono } from "hono";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { API_ROUTES } from "../../../shared/api/routes.js";
import { SHARE_FILE_MAX_BYTES, type FileError, type SharedFileSaved } from "../../../shared/api/files.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ShareFileDeps {
  /** The user's Downloads folder (made when missing). */
  downloadsDir: string;
  now?: () => Date;
  maxBytes?: number;
}

const two = (n: number) => String(n).padStart(2, "0");

/** The name a shared file is saved under, by the local time it was saved. */
function baseName(at: Date): string {
  return `mandate-share-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

/** The extension a body is saved with, or null when it is neither a PNG nor
 *  UTF-8 Markdown. */
function extensionOf(type: string, body: Buffer): ".png" | ".md" | null {
  const media = type.split(";")[0]!.trim().toLowerCase();
  if (media === "image/png") return body.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? ".png" : null;
  if (media === "text/markdown") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
      return ".md";
    } catch {
      return null;
    }
  }
  return null;
}

/** A shared image or text, saved for the desktop app, whose webview has no
 *  downloads: written into the Downloads folder under a dated name, with a
 *  number after it when that name is taken, never over a file. */
export function mountShareFileRoutes(app: Hono, deps: ShareFileDeps): void {
  const maxBytes = deps.maxBytes ?? SHARE_FILE_MAX_BYTES;
  app.post(API_ROUTES.shareFiles, async (c) => {
    const tooLarge = () => c.json({ error: "the file is too large", code: "too_large" } satisfies FileError, 413);
    if (Number(c.req.header("content-length") ?? 0) > maxBytes) return tooLarge();
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.length > maxBytes) return tooLarge();
    const ext = extensionOf(c.req.header("content-type") ?? "", body);
    if (!ext) return c.json({ error: "only a PNG image or Markdown text can be saved", code: "invalid" } satisfies FileError, 400);
    const base = baseName((deps.now ?? (() => new Date()))());
    const file = await saveUnderFreeName(deps.downloadsDir, base, ext, (to) => fsp.writeFile(to, body, { flag: "wx" }));
    return file ? c.json({ path: file } satisfies SharedFileSaved) : c.json({ error: "no free name to save under", code: "invalid" } satisfies FileError, 409);
  });
}

/** Writes a file into `dir` (made when missing) as `<base><ext>`, or with
 *  "-2", "-3"… after the base when that name is taken: `put` must refuse to
 *  write over a file (EEXIST), so none is ever replaced. The path it wrote,
 *  or null when no name was free. */
export async function saveUnderFreeName(dir: string, base: string, ext: string, put: (file: string) => Promise<void>): Promise<string | null> {
  await fsp.mkdir(dir, { recursive: true });
  for (let n = 1; n <= 1000; n++) {
    const file = path.join(dir, `${base}${n === 1 ? "" : `-${n}`}${ext}`);
    try {
      await put(file);
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return null;
}
