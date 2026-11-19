import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_PAGE_FIRST, AGENT_PAGE_LIMITS } from "../../../shared/api/agent-page.js";
import { CANVAS_PAGE_MAX_BYTES } from "../../../shared/canvas-page.js";
import { errorText } from "../../../shared/error-text.js";

/** The page's own folder inside the page folder: everything in it is the
 *  page, published together. The rest of the page folder (sources.json, the
 *  scripts its sources run) is never published nor served. */
export const PAGE_SITE_DIR = "site";

/** A file of the site, by its path in site/ ("/" between folders). */
export interface SiteFile { path: string; bytes: Uint8Array }

/** site/ as read: its files and their digest, or why it is refused, with a
 *  digest of what was there so the same refusal is told once. */
export type SiteRead = { digest: string; files: SiteFile[] } | { digest: string; refused: string };

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** A file's content as kept: what tells whether it changed. */
export const siteFileDigest = (bytes: Uint8Array): string => sha256(bytes);

/** The site's digest from its files' paths and digests, in any order. */
export function siteDigest(entries: ReadonlyArray<{ path: string; digest: string }>): string {
  const lines = entries.map((e) => `${e.path}\0${e.digest}\n`).sort();
  return sha256(lines.join(""));
}

/** Names that begin with a dot (.DS_Store, an editor's folder) are not the page's. */
const hidden = (name: string) => name.startsWith(".");

interface Found { path: string; file: string; stat: fs.Stats }

/** Every regular file under `dir`, by its path from `root`. A link is not
 *  followed: what it points at, inside site/ or out, is not the page's. */
function walk(root: string, dir: string, found: Found[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (hidden(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, file, found);
    else if (entry.isFile()) found.push({ path: path.relative(root, file).split(path.sep).join("/"), file, stat: fs.statSync(file) });
  }
}

/** What is at this path itself (a link, not what it points at); null: nothing. */
function entryAt(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

/** Whether site/ is a folder of its own: not a file, and not a link (what
 *  a link points at is not the page folder's to publish or clear). */
const isOwnFolder = (siteDir: string) => entryAt(siteDir)?.isDirectory() === true;

/** site/ as it is now; null when it is missing, not a folder of its own,
 *  or holds no files: no page to publish. */
export function readSite(siteDir: string): SiteRead | null {
  if (!isOwnFolder(siteDir)) return null;
  const found: Found[] = [];
  try {
    walk(siteDir, siteDir, found);
  } catch (err) {
    return { digest: `unreadable:${errorText(err)}`, refused: `site/ could not be read: ${errorText(err)}` };
  }
  if (found.length === 0) return null;
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // What was there, by size and time: a refusal's digest, read without the bytes.
  const seen = sha256(found.map((f) => `${f.path}\0${f.stat.size}\0${f.stat.mtimeMs}\n`).join(""));
  const refused = (reason: string): SiteRead => ({ digest: `refused:${seen}`, refused: reason });
  if (found.length > AGENT_PAGE_LIMITS.siteFiles) {
    return refused(`site/ holds ${found.length} files, over the limit of ${AGENT_PAGE_LIMITS.siteFiles}`);
  }
  // Sized on disk first: an oversized site is refused without reading it.
  const total = found.reduce((sum, f) => sum + f.stat.size, 0);
  if (total > CANVAS_PAGE_MAX_BYTES) return refused(`site/ is ${(total / 1024 / 1024).toFixed(1)} MB, over the 16 MB limit`);
  if (!found.some((f) => f.path === AGENT_PAGE_FIRST)) return refused(`site/ has no ${AGENT_PAGE_FIRST}`);
  const files: SiteFile[] = [];
  for (const f of found) {
    try {
      files.push({ path: f.path, bytes: new Uint8Array(fs.readFileSync(f.file)) });
    } catch (err) {
      return refused(`site/${f.path} could not be read: ${errorText(err)}`);
    }
  }
  return { digest: siteDigest(files.map((f) => ({ path: f.path, digest: siteFileDigest(f.bytes) }))), files };
}

/** site/ made as given: every entry not hidden goes, then the files are
 *  written. Throws when it cannot be done (site/ not a folder of its own). */
export function restoreSite(siteDir: string, files: readonly SiteFile[]): void {
  const there = entryAt(siteDir);
  if (!there) fs.mkdirSync(siteDir);
  else if (!there.isDirectory()) throw new Error("site/ is not a folder of its own");
  for (const entry of fs.readdirSync(siteDir)) {
    if (!hidden(entry)) fs.rmSync(path.join(siteDir, entry), { recursive: true, force: true });
  }
  for (const file of files) {
    const target = path.join(siteDir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes);
  }
}

/** The page folder's site/, made when it is missing. A page folder from
 *  before site/ had its page in page/index.html: that moves in, so the page
 *  published last is what site/ starts from. */
export function prepareSite(pageDir: string): void {
  const siteDir = path.join(pageDir, PAGE_SITE_DIR);
  // Anything there, a link that points nowhere too, is left as it is.
  if (entryAt(siteDir)) return;
  fs.mkdirSync(siteDir);
  const old = path.join(pageDir, AGENT_PAGE_FIRST);
  if (entryAt(old)?.isFile()) fs.renameSync(old, path.join(siteDir, AGENT_PAGE_FIRST));
}
