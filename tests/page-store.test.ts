import { expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { PageStore } from "../src/server/modules/page/page-store.js";

let env: StoresEnv | null = null;

function store(): PageStore {
  env = freshStoresEnv("md-page-store-");
  return new PageStore(env.store.db);
}

const enc = (body: string) => new TextEncoder().encode(body);
/** A site of these files, by path. */
const site = (files: Record<string, string | Uint8Array>) =>
  Object.entries(files).map(([path, body]) => ({ path, bytes: typeof body === "string" ? enc(body) : body }));
const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

test("publishing the same files twice keeps one version", () => {
  const pages = store();
  const first = pages.publish(site({ "index.html": "<p>one</p>" }), "agent");
  expect(first?.revision).toBe(1);
  expect(pages.publish(site({ "index.html": "<p>one</p>" }), "agent")).toBeNull();
  expect(pages.latest()?.revision).toBe(1);
  const second = pages.publish(site({ "index.html": "<p>two</p>" }), "Put usage first");
  expect(second).toMatchObject({ revision: 2, pages: { "index.html": "<p>two</p>" }, writer: "Put usage first" });
  expect(pages.version(1)?.pages).toEqual({ "index.html": "<p>one</p>" });
  expect(pages.version(3)).toBeNull();
  // A file added, or one taken away, is a new version too.
  expect(pages.publish(site({ "index.html": "<p>two</p>", "style.css": "p{}" }), "agent")?.revision).toBe(3);
  expect(pages.publish(site({ "index.html": "<p>two</p>" }), "agent")?.revision).toBe(4);
});

test("a version holds every file of the site; its pages are its .html files, the rest is read by path", () => {
  const pages = store();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  const version = pages.publish(site({ "index.html": "<h1>Today</h1>", "mr/list.html": "<h1>MRs</h1>", "style.css": "h1{}", "img/dot.png": png }), "agent")!;
  expect(version.pages).toEqual({ "index.html": "<h1>Today</h1>", "mr/list.html": "<h1>MRs</h1>" });
  expect(text(pages.file(1, "style.css"))).toBe("h1{}");
  expect([...pages.file(1, "img/dot.png")!]).toEqual([...png]);
  expect(pages.file(1, "img/none.png")).toBeNull();
  expect(pages.file(2, "style.css")).toBeNull();
  expect(pages.files(1).map((f) => f.path)).toEqual(["img/dot.png", "index.html", "mr/list.html", "style.css"]);
});

test("only the newest 5 versions are kept, and what only they held goes with them", () => {
  const pages = store();
  for (let i = 1; i <= 7; i += 1) pages.publish(site({ "index.html": `<p>${i}</p>`, "shared.css": "p{}" }), "agent");
  expect(pages.latest()?.revision).toBe(7);
  expect(pages.version(2)).toBeNull();
  expect(pages.file(2, "shared.css")).toBeNull();
  expect(pages.version(3)?.pages).toEqual({ "index.html": "<p>3</p>" });
  const count = (table: string) => (env!.store.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
  expect(count("agent_page_versions")).toBe(5);
  // A file the same in every version is kept once.
  expect(count("agent_page_blobs")).toBe(6);
});

test("a version from before the site, its html alone, reads as its index.html", () => {
  const pages = store();
  env!.store.db.prepare("insert into agent_page_versions (revision, html, writer, created_at) values (1, ?, 'agent', '2026-11-01T00:00:00.000Z')")
    .run("<h1>Old</h1>");
  expect(pages.latest()).toMatchObject({ revision: 1, pages: { "index.html": "<h1>Old</h1>" } });
  expect(text(pages.file(1, "index.html"))).toBe("<h1>Old</h1>");
  expect(pages.files(1).map((f) => [f.path, text(f.bytes)])).toEqual([["index.html", "<h1>Old</h1>"]]);
  // The same page moved into the site is no new version.
  expect(pages.publish(site({ "index.html": "<h1>Old</h1>" }), "agent")).toBeNull();
  expect(pages.publish(site({ "index.html": "<h1>Old</h1>", "style.css": "h1{}" }), "agent")?.revision).toBe(2);
});

test("a page subagent's write runs, then ends; the state shows the running one first", () => {
  const pages = store();
  expect(pages.state()).toEqual({ latest: null, write: null });
  pages.startWrite("task_a", "Put usage first");
  expect(pages.state().write).toMatchObject({ taskId: "task_a", title: "Put usage first", status: "running", finishedAt: null });
  // A newer write that has ended does not hide the one still running.
  pages.startWrite("task_b", "Add the error table");
  pages.finishWrite("task_b", { status: "failed", revision: null, error: "stopped" });
  expect(pages.state().write).toMatchObject({ taskId: "task_a", status: "running" });
  const version = pages.publish(site({ "index.html": "<p>a</p>" }), "Put usage first")!;
  pages.finishWrite("task_a", { status: "published", revision: version.revision, error: null });
  // None running: the one started last.
  expect(pages.state()).toMatchObject({
    latest: { revision: 1, writer: "Put usage first" },
    write: { taskId: "task_b", status: "failed", error: "stopped" }
  });
  expect("pages" in pages.state().latest!).toBe(false);
});

test("writes still running when Mandate starts are failed, and named", () => {
  const pages = store();
  pages.startWrite("task_a", "One");
  pages.startWrite("task_b", "Two");
  pages.finishWrite("task_b", { status: "unchanged", revision: null, error: null });
  expect(pages.markRunningWritesFailed("Mandate restarted")).toEqual(["task_a"]);
  expect(pages.state().write).toMatchObject({ taskId: "task_b", status: "unchanged" });
  const row = env!.store.db.prepare("select status, error from agent_page_writes where task_id = 'task_a'").get();
  expect(row).toEqual({ status: "failed", error: "Mandate restarted" });
});
