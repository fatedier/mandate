import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { PageStore } from "../src/server/modules/page/page-store.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function store(): PageStore {
  env = freshStoresEnv("md-page-store-");
  return new PageStore(env.store.db);
}

test("publishing the same html twice keeps one version", () => {
  const pages = store();
  const first = pages.publish("<p>one</p>", "agent");
  expect(first?.revision).toBe(1);
  expect(pages.publish("<p>one</p>", "agent")).toBeNull();
  expect(pages.latest()?.revision).toBe(1);
  const second = pages.publish("<p>two</p>", "Put usage first");
  expect(second).toMatchObject({ revision: 2, html: "<p>two</p>", writer: "Put usage first" });
  expect(pages.version(1)?.html).toBe("<p>one</p>");
  expect(pages.version(3)).toBeNull();
});

test("only the newest 50 versions are kept", () => {
  const pages = store();
  for (let i = 1; i <= 52; i += 1) pages.publish(`<p>${i}</p>`, "agent");
  expect(pages.latest()?.revision).toBe(52);
  expect(pages.version(2)).toBeNull();
  expect(pages.version(3)?.html).toBe("<p>3</p>");
  const kept = env!.store.db.prepare("select count(*) as n from agent_page_versions").get() as { n: number };
  expect(kept.n).toBe(50);
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
  const version = pages.publish("<p>a</p>", "Put usage first")!;
  pages.finishWrite("task_a", { status: "published", revision: version.revision, error: null });
  // None running: the one started last.
  expect(pages.state()).toMatchObject({
    latest: { revision: 1, writer: "Put usage first" },
    write: { taskId: "task_b", status: "failed", error: "stopped" }
  });
  expect("html" in pages.state().latest!).toBe(false);
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
