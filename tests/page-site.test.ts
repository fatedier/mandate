import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareSite, readSite, restoreSite } from "../src/server/modules/page/page-site.js";
import { AGENT_PAGE_LIMITS } from "../src/shared/api/agent-page.js";
import { CANVAS_PAGE_MAX_BYTES } from "../src/shared/canvas-page.js";
import { onCleanup } from "./helpers/cleanup.js";

// The page is page/site/: every file in it is the page, published together;
// the rest of page/ (sources.json, the scripts its sources run) is not.

function pageDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-page-site-"));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root: string, name: string, body: string | Uint8Array): void {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("the site is every file under site/, folders included, by path; names that begin with a dot are left out", () => {
  const site = path.join(pageDir(), "site");
  put(site, "index.html", "<h1>Today</h1>");
  put(site, "mr.html", "<h1>MRs</h1>");
  put(site, "css/style.css", "h1{color:red}");
  put(site, "img/dot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]));
  put(site, ".DS_Store", "x");
  put(site, ".cache/a.js", "x");
  const read = readSite(site);
  if (!read || !("files" in read)) throw new Error(`expected files, got ${JSON.stringify(read)}`);
  expect(read.files.map((f) => f.path)).toEqual(["css/style.css", "img/dot.png", "index.html", "mr.html"]);
  expect(text(read.files.find((f) => f.path === "index.html")!.bytes)).toBe("<h1>Today</h1>");
  expect([...read.files.find((f) => f.path === "img/dot.png")!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  // The same files read the same; one changed byte anywhere is another site.
  expect(readSite(site)?.digest).toBe(read.digest);
  put(site, "css/style.css", "h1{color:blue}");
  expect(readSite(site)?.digest).not.toBe(read.digest);
});

test("a link in site/ is not followed: what it points at, inside or out, is not the page's", () => {
  const dir = pageDir();
  const site = path.join(dir, "site");
  put(site, "index.html", "<h1>Today</h1>");
  put(dir, "cn_mig.py", "TOKEN = 'secret'");
  fs.symlinkSync(path.join(dir, "cn_mig.py"), path.join(site, "script.js"));
  fs.symlinkSync(path.join(site, "index.html"), path.join(site, "copy.html"));
  const read = readSite(site);
  expect(read && "files" in read ? read.files.map((f) => f.path) : read).toEqual(["index.html"]);
});

test("a site/ that is itself a link is no page, and is never put back: what it points at stays as it is", () => {
  const dir = pageDir();
  const elsewhere = path.join(dir, "reports");
  put(elsewhere, "index.html", "<h1>A report</h1>");
  put(elsewhere, "notes.md", "keep me");
  fs.symlinkSync(elsewhere, path.join(dir, "site"));
  expect(readSite(path.join(dir, "site"))).toBeNull();
  expect(() => restoreSite(path.join(dir, "site"), [])).toThrow();
  expect(fs.readdirSync(elsewhere).sort()).toEqual(["index.html", "notes.md"]);
  // Nor is one made in its place at start, even when it points nowhere.
  fs.rmSync(path.join(dir, "site"));
  fs.symlinkSync(path.join(dir, "gone"), path.join(dir, "site"));
  put(dir, "index.html", "<h1>Old</h1>");
  prepareSite(dir);
  expect(fs.lstatSync(path.join(dir, "site")).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(path.join(dir, "index.html"))).toBe(true);
});

test("no site/, or one with no files, is no page: nothing to publish", () => {
  const dir = pageDir();
  expect(readSite(path.join(dir, "site"))).toBeNull();
  fs.mkdirSync(path.join(dir, "site", "empty"), { recursive: true });
  put(path.join(dir, "site"), ".DS_Store", "x");
  expect(readSite(path.join(dir, "site"))).toBeNull();
  // A file where the folder should be holds no page either.
  fs.rmSync(path.join(dir, "site"), { recursive: true });
  fs.writeFileSync(path.join(dir, "site"), "x");
  expect(readSite(path.join(dir, "site"))).toBeNull();
});

test("a site with no index.html, too many files or too many bytes is refused, with why", () => {
  const site = path.join(pageDir(), "site");
  put(site, "mr.html", "<h1>MRs</h1>");
  expect(readSite(site)).toMatchObject({ refused: "site/ has no index.html" });
  // index.html in a folder is not the first page.
  put(site, "sub/index.html", "<h1>Sub</h1>");
  expect(readSite(site)).toMatchObject({ refused: "site/ has no index.html" });
  put(site, "index.html", "<h1>Today</h1>");
  // Three files so far: the limit, then one over.
  for (let i = 0; i < AGENT_PAGE_LIMITS.siteFiles - 3; i += 1) put(site, `img/${i}.png`, "x");
  expect(readSite(site) && "files" in readSite(site)!).toBe(true);
  put(site, "one-more.css", "x");
  expect(readSite(site)).toMatchObject({ refused: `site/ holds ${AGENT_PAGE_LIMITS.siteFiles + 1} files, over the limit of 200` });
  fs.rmSync(path.join(site, "img"), { recursive: true });
  // The bytes of every file together.
  put(site, "big.png", new Uint8Array(CANVAS_PAGE_MAX_BYTES - 1000));
  expect(readSite(site) && "files" in readSite(site)!).toBe(true);
  put(site, "more.png", new Uint8Array(2000));
  expect(readSite(site)).toMatchObject({ refused: "site/ is 16.0 MB, over the 16 MB limit" });
});

test("a refused site reads the same until a file of it changes, so it is told once", () => {
  const site = path.join(pageDir(), "site");
  put(site, "mr.html", "<h1>MRs</h1>");
  const first = readSite(site);
  expect(readSite(site)?.digest).toBe(first!.digest);
  put(site, "mr.html", "<h1>MRs, more</h1>");
  expect(readSite(site)?.digest).not.toBe(first!.digest);
});

test("an old page/index.html moves into site/ when there is no site/ yet; after that page/ is left as it is", () => {
  const dir = pageDir();
  put(dir, "index.html", "<h1>Old</h1>");
  put(dir, "sources.json", "[]");
  put(dir, "backlog.py", "print(1)");
  prepareSite(dir);
  expect(fs.readFileSync(path.join(dir, "site", "index.html"), "utf8")).toBe("<h1>Old</h1>");
  expect(fs.existsSync(path.join(dir, "index.html"))).toBe(false);
  expect(fs.readdirSync(dir).sort()).toEqual(["backlog.py", "site", "sources.json"]);
  // site/ is there now: a page/index.html written later stays where it is.
  put(dir, "index.html", "<h1>Stray</h1>");
  prepareSite(dir);
  expect(fs.readFileSync(path.join(dir, "site", "index.html"), "utf8")).toBe("<h1>Old</h1>");
  expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<h1>Stray</h1>");
  // A new page folder gets an empty site/.
  const fresh = pageDir();
  prepareSite(fresh);
  expect(fs.readdirSync(path.join(fresh, "site"))).toEqual([]);
});

test("a site is put back as given: what is not in it goes, its names that begin with a dot stay", () => {
  const site = path.join(pageDir(), "site");
  put(site, "index.html", "<h1>Half</h1>");
  put(site, "new.html", "<h1>New</h1>");
  put(site, "img/new.png", "x");
  put(site, ".DS_Store", "x");
  restoreSite(site, [
    { path: "index.html", bytes: new TextEncoder().encode("<h1>One</h1>") },
    { path: "css/style.css", bytes: new TextEncoder().encode("h1{}") }
  ]);
  const read = readSite(site);
  expect(read && "files" in read ? read.files.map((f) => [f.path, text(f.bytes)]) : read).toEqual([["css/style.css", "h1{}"], ["index.html", "<h1>One</h1>"]]);
  expect(fs.existsSync(path.join(site, ".DS_Store"))).toBe(true);
  // None: nothing of the page is left.
  restoreSite(site, []);
  expect(readSite(site)).toBeNull();
  // site/ taken away whole is made again.
  fs.rmSync(site, { recursive: true });
  restoreSite(site, [{ path: "index.html", bytes: new TextEncoder().encode("<h1>One</h1>") }]);
  expect(fs.readFileSync(path.join(site, "index.html"), "utf8")).toBe("<h1>One</h1>");
});
