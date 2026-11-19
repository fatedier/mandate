import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { tempDir } from "./helpers/temp.js";
import { mountFileRoutes } from "../src/server/modules/files/file-routes.js";
import { API_PATHS } from "../src/shared/api-contracts.js";
import type { FileDto, FileError } from "../src/shared/api/files.js";

// A file an agent links opens in the page only from the folders its work
// lives in: projects, worktrees, Mandate's resources and temporary folders;
// never Mandate's own config, credentials or database.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** A project, a worktree and a data folder, each its own temp folder; the
 *  temporary roots are given per test (none unless asked). */
function setup(over: { tmpRoots?: string[]; dataDir?: string } = {}) {
  const env = freshStoresEnv("md-files-");
  const project = tempDir("md-files-project-");
  const worktree = tempDir("md-files-worktree-");
  const dataDir = over.dataDir ?? tempDir("md-files-data-");
  const downloads = path.join(tempDir("md-files-home-"), "Downloads");
  const projectId = seedProject(env.projects, { name: "project-1", workingDir: project });
  seedWorker(env.workers, projectId, { name: "cache-expiry", mode: "new-branch-new-worktree", branch: "cache-expiry", worktreePath: worktree });
  const app = new Hono();
  mountFileRoutes(app, { projects: env.projects, workers: env.workers, dataDir, tmpRoots: over.tmpRoots ?? [], downloadsDir: downloads });
  const write = (dir: string, rel: string, body: string | Uint8Array) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const get = async (p: string, opts?: Parameters<typeof API_PATHS.file>[1]) => {
    const res = await app.request(API_PATHS.file(p, opts));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const dto = async (p: string, opts?: Parameters<typeof API_PATHS.file>[1]) => (await get(p, opts)).body as unknown as FileDto;
  const raw = (p: string) => app.request(API_PATHS.fileRaw(p));
  const download = (p: string) => app.request(API_PATHS.fileDownload(p));
  const save = async (p: unknown) => {
    const res = await app.request(API_PATHS.fileSave, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { env, project, worktree, dataDir, downloads, write, get, dto, raw, download, save };
}

test("a file in each allowed folder opens; one elsewhere is outside", async () => {
  const tmp = tempDir("md-files-tmp-");
  const s = setup({ tmpRoots: [tmp] });
  const files = [
    s.write(s.project, "docs/report.md", "# Report\n"),
    s.write(s.worktree, "src/expiry.ts", "export const ttl = 60;\n"),
    s.write(s.dataDir, "resources/threads/thr_1/notes/index.md", "- open matter\n"),
    s.write(tmp, "scratch/out.txt", "done\n")
  ];
  for (const file of files) {
    const r = await s.get(file);
    expect([file, r.status]).toEqual([file, 200]);
    expect(r.body).toMatchObject({ path: file, name: path.basename(file), folder: path.dirname(file) });
  }
  const elsewhere = s.write(tempDir("md-files-elsewhere-"), "a.md", "x");
  expect(await s.get(elsewhere)).toEqual({ status: 403, body: { error: expect.any(String), code: "outside" } });
});

test("a symlink inside a project that points outside it is refused", async () => {
  const s = setup();
  const secret = s.write(tempDir("md-files-elsewhere-"), "id_key", "secret\n");
  fs.symlinkSync(secret, path.join(s.project, "key-link"));
  fs.symlinkSync(path.dirname(secret), path.join(s.project, "dir-link"));
  expect((await s.get(path.join(s.project, "key-link"))).body.code).toBe("outside");
  expect((await s.get(path.join(s.project, "dir-link", "id_key"))).body.code).toBe("outside");
});

test("inside the data folder only resources and worktrees open, even when a root contains it", async () => {
  const tmp = tempDir("md-files-tmp-");
  const dataDir = path.join(tmp, "data");
  const s = setup({ tmpRoots: [tmp], dataDir });
  for (const rel of ["config.json", "auth.json", "mandate.db", "shell-snapshots/env.sh"]) {
    const file = s.write(dataDir, rel, "{}");
    expect([rel, (await s.get(file)).body.code]).toEqual([rel, "outside"]);
  }
  for (const rel of ["resources/global/agent/notes/index.md", "worktrees/project-1/cache-expiry/a.ts"]) {
    const file = s.write(dataDir, rel, "x\n");
    expect([rel, (await s.get(file)).status]).toEqual([rel, 200]);
  }
});

test("each kind is told apart, and only text kinds carry their text", async () => {
  const s = setup();
  const cases: Array<[string, string | Uint8Array, string, boolean]> = [
    ["docs/report.md", "# Report\n", "markdown", true],
    ["docs/shot.png", PNG, "image", false],
    ["docs/page.html", "<h1>Hi</h1>\n", "html", true],
    ["docs/spec.pdf", "%PDF-1.4\n", "pdf", false],
    ["src/expiry.ts", "export const ttl = 60;\n", "text", true],
    ["bin/tool", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]), "other", false],
    ["notes/plain", "中文笔记\n", "text", true]
  ];
  for (const [rel, body, kind, hasText] of cases) {
    const r = await s.get(s.write(s.project, rel, body));
    expect([rel, r.body.kind, "text" in r.body]).toEqual([rel, kind, hasText]);
  }
  const md = await s.get(path.join(s.project, "docs/report.md"));
  expect(md.body).toMatchObject({ text: "# Report\n", size: 9 });
  expect(Date.parse(String(md.body.modifiedAt))).toBeGreaterThan(0);
  expect(md.body.part).toBeUndefined();
});

test("large text: the first 2 MiB, the last, and the window around a line, each cut at line ends with its first line's number", async () => {
  const s = setup();
  const lines = 500_000;
  const body = Array.from({ length: lines }, (_, i) => `line ${String(i + 1).padStart(6, "0")}\n`).join("");
  const file = s.write(s.project, "logs/big.log", body);
  const lineOf = (text: string, at: number) => text.split("\n")[at]!;
  const check = (dto: FileDto) => {
    expect(Buffer.byteLength(dto.text!)).toBeLessThanOrEqual(2_097_152);
    expect(dto.text!.endsWith("\n")).toBe(true);
    expect(lineOf(dto.text!, 0)).toBe(`line ${String(dto.firstLine).padStart(6, "0")}`);
  };
  const start = await s.dto(file);
  expect(start).toMatchObject({ kind: "text", part: "start", firstLine: 1, size: Buffer.byteLength(body) });
  check(start);
  const end = await s.dto(file, { part: "end" });
  expect(end.part).toBe("end");
  check(end);
  expect(end.text!.endsWith(`line ${String(lines).padStart(6, "0")}\n`)).toBe(true);
  const around = await s.dto(file, { line: 250_000 });
  expect(around.part).toBe("around");
  check(around);
  expect(around.text).toContain("line 250000\n");
  // A line in the first or the last part is shown there.
  expect((await s.get(file, { line: 10 })).body.part).toBe("start");
  expect((await s.get(file, { line: lines - 5 })).body.part).toBe("end");
  // Past the end: the start.
  expect((await s.get(file, { line: lines + 100 })).body.part).toBe("start");
});

test("errors: a relative path is invalid, a missing file missing, a folder a folder", async () => {
  const s = setup();
  expect(await s.get("docs/report.md")).toEqual({ status: 400, body: { error: expect.any(String), code: "invalid" } });
  expect(await s.get(path.join(s.project, "gone.md"))).toEqual({ status: 404, body: { error: expect.any(String), code: "missing" } });
  fs.mkdirSync(path.join(s.project, "docs"), { recursive: true });
  expect(await s.get(path.join(s.project, "docs"))).toEqual({ status: 409, body: { error: expect.any(String), code: "folder" } });
});

test("raw serves images and PDFs with their headers, refuses other kinds, and an image over 20 MiB is too large", async () => {
  const s = setup();
  const png = await s.raw(s.write(s.project, "docs/shot.png", PNG));
  expect(png.status).toBe(200);
  expect([png.headers.get("content-type"), png.headers.get("content-security-policy"), png.headers.get("x-content-type-options")]).toEqual(["image/png", "sandbox", "nosniff"]);
  expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
  const pdf = await s.raw(s.write(s.project, "docs/spec.pdf", "%PDF-1.4\n"));
  expect([pdf.status, pdf.headers.get("content-type"), pdf.headers.get("x-content-type-options")]).toEqual([200, "application/pdf", "nosniff"]);
  const text = await s.raw(s.write(s.project, "src/a.ts", "x\n"));
  expect([text.status, (await text.json() as FileError).code]).toEqual([400, "invalid"]);
  const big = s.write(s.project, "docs/huge.png", new Uint8Array(20_971_521));
  const huge = await s.raw(big);
  expect([huge.status, (await huge.json() as FileError).code]).toEqual([413, "too_large"]);
  const outside = await s.raw(s.write(tempDir("md-files-elsewhere-"), "x.png", PNG));
  expect([outside.status, (await outside.json() as FileError).code]).toEqual([403, "outside"]);
});

test("the temporary folders are allowed by default", async () => {
  const env = freshStoresEnv("md-files-");
  const app = new Hono();
  mountFileRoutes(app, { projects: env.projects, workers: env.workers, dataDir: tempDir("md-files-data-"), downloadsDir: path.join(tempDir("md-files-home-"), "Downloads") });
  const file = path.join(tempDir("md-files-default-"), "out.txt");
  fs.writeFileSync(file, "done\n");
  expect((await app.request(API_PATHS.file(file))).status).toBe(200);
});

test("raw serves a file as the kind its name says: a .pdf or .png that links to a page is never sent as a page", async () => {
  const s = setup();
  const page = s.write(s.project, "docs/page.html", "<script>fetch('/api/settings')</script>");
  fs.symlinkSync(page, path.join(s.project, "docs/manual.pdf"));
  fs.symlinkSync(page, path.join(s.project, "docs/chart.png"));
  const pdf = await s.raw(path.join(s.project, "docs/manual.pdf"));
  expect([pdf.status, pdf.headers.get("content-type")]).toEqual([200, "application/pdf"]);
  const png = await s.raw(path.join(s.project, "docs/chart.png"));
  expect([png.status, png.headers.get("content-type"), png.headers.get("content-security-policy")]).toEqual([200, "image/png", "sandbox"]);
});

test("large text: the window around a line near either part's edge starts at the right line", async () => {
  const s = setup();
  // Lines of uneven length, so a line's number is not its offset over a constant.
  const body = Array.from({ length: 400_000 }, (_, i) => `${i + 1}:${"x".repeat(i % 17)}\n`).join("");
  const file = s.write(s.project, "logs/uneven.log", body);
  for (const line of [180_000, 200_000, 260_000, 399_990]) {
    const dto = await s.dto(file, { line });
    const first = dto.text!.split("\n")[0]!;
    expect([line, first.split(":")[0]]).toEqual([line, String(dto.firstLine)]);
    expect([line, dto.text!.includes(`\n${line}:`) || first.startsWith(`${line}:`)]).toEqual([line, true]);
  }
  const end = await s.dto(file, { part: "end" });
  expect(end.text!.split("\n")[0]!.split(":")[0]).toBe(String(end.firstLine));
});

// Download: the file as it is, whatever its kind, for the browser to save
// under its own name. Never shown as a page on Mandate's origin.
test("download sends any file as an attachment under its own name, its bytes as they are", async () => {
  const s = setup();
  const csv = "id,name\n1,Alex Lee\n";
  const res = await s.download(s.write(s.project, "out/名单-20261109.csv", csv));
  expect(res.status).toBe(200);
  expect([res.headers.get("content-type"), res.headers.get("x-content-type-options"), res.headers.get("cache-control")])
    .toEqual(["application/octet-stream", "nosniff", "no-store"]);
  expect(res.headers.get("content-disposition")).toBe(`attachment; filename="__-20261109.csv"; filename*=UTF-8''${encodeURIComponent("名单-20261109.csv")}`);
  expect(await res.text()).toBe(csv);
  // A kind the page cannot show, and a page: both only as bytes to save.
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255]);
  const xlsx = await s.download(s.write(s.project, "out/model.xlsx", bytes));
  expect([xlsx.status, xlsx.headers.get("content-disposition")]).toEqual([200, `attachment; filename="model.xlsx"; filename*=UTF-8''model.xlsx`]);
  expect(Buffer.from(await xlsx.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  // A name with an apostrophe or brackets: those are escaped too in the exact
  // name (RFC 5987 leaves them out), or a browser would drop it.
  const quoted = await s.download(s.write(s.project, "out/l'été (1).csv", "x"));
  expect(quoted.headers.get("content-disposition")).toBe(`attachment; filename="l'_t_ (1).csv"; filename*=UTF-8''l%27%C3%A9t%C3%A9%20%281%29.csv`);
  const html = await s.download(s.write(s.project, "out/page.html", "<script>alert(1)</script>"));
  expect([html.headers.get("content-type"), html.headers.get("content-disposition")?.startsWith("attachment;")]).toEqual(["application/octet-stream", true]);
});

test("download refuses what the file view refuses: outside the folders, a folder, a missing file", async () => {
  const s = setup();
  const code = async (p: string) => { const res = await s.download(p); return [res.status, (await res.json() as FileError).code]; };
  expect(await code(s.write(tempDir("md-files-elsewhere-"), "a.csv", "x"))).toEqual([403, "outside"]);
  fs.mkdirSync(path.join(s.project, "docs"), { recursive: true });
  expect(await code(path.join(s.project, "docs"))).toEqual([409, "folder"]);
  expect(await code(path.join(s.project, "gone.csv"))).toEqual([404, "missing"]);
});

// The desktop app's webview downloads nothing: the server puts a copy in the
// user's Downloads folder instead, as it does for what is shared.
test("save puts a copy in Downloads under the file's own name, a second beside it, never over a file", async () => {
  const s = setup();
  const file = s.write(s.project, "out/leaders.csv", "id,name\n1,Alex Lee\n");
  const first = await s.save(file);
  expect(first).toEqual({ status: 200, body: { path: path.join(s.downloads, "leaders.csv") } });
  expect(fs.readFileSync(path.join(s.downloads, "leaders.csv"), "utf8")).toBe("id,name\n1,Alex Lee\n");
  fs.writeFileSync(path.join(s.downloads, "leaders-2.csv"), "someone else's");
  const second = await s.save(file);
  expect(second.body.path).toBe(path.join(s.downloads, "leaders-3.csv"));
  expect(fs.readFileSync(path.join(s.downloads, "leaders-2.csv"), "utf8")).toBe("someone else's");
  expect(fs.readdirSync(s.downloads).sort()).toEqual(["leaders-2.csv", "leaders-3.csv", "leaders.csv"]);
});

test("save refuses what the file view refuses, and writes nothing", async () => {
  const s = setup();
  expect((await s.save(s.write(tempDir("md-files-elsewhere-"), "a.csv", "x"))).body.code).toBe("outside");
  fs.mkdirSync(path.join(s.project, "docs"), { recursive: true });
  expect((await s.save(path.join(s.project, "docs"))).body.code).toBe("folder");
  expect((await s.save(42)).body.code).toBe("invalid");
  expect(fs.existsSync(s.downloads)).toBe(false);
});
