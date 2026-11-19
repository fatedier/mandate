import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { PagePublisher } from "../src/server/modules/page/page-publisher.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { SseEvent } from "../src/shared/api-contracts.js";
import { CANVAS_PAGE_MAX_BYTES } from "../src/shared/canvas-page.js";

let env: StoresEnv | null = null;

interface Applied { names: string[] | null; error: string | null }

interface UpdatesOver {
  /** What applying updates.json comes to. */
  updates?: Applied;
  updatesFile?: () => string;
  /** The page subagents a scheduled update started, and how each ended. */
  scheduled?: Map<string, { status: string; error: string | null } | null>;
}

function publisherEnv(applied: Applied = { names: [], error: null }, sourcesFile = () => "[]\n", over: UpdatesOver = {}) {
  env = freshStoresEnv("md-page-publisher-");
  const store = new PageStore(env.store.db);
  const pageDir = path.join(env.dir, "agent", "page");
  fs.mkdirSync(pageDir, { recursive: true });
  const sse = new AgentSseEmitter();
  const events: SseEvent[] = [];
  sse.addSink((e) => events.push(e));
  const thread = env.agentStore.getOrCreatePersonalThread();
  let applies = 0;
  let updateApplies = 0;
  const publisher = new PagePublisher({
    store,
    agentStore: env.agentStore,
    pageDir,
    personalThreadId: () => thread.id,
    applySources: () => { applies += 1; return applied; },
    sourcesFile,
    applyUpdates: () => { updateApplies += 1; return over.updates ?? { names: [], error: null }; },
    updatesFile: over.updatesFile ?? (() => "[]\n"),
    scheduledEnded: (taskId, end) => {
      if (!over.scheduled?.has(taskId)) return false;
      over.scheduled.set(taskId, end);
      return true;
    },
    sse
  });
  const notes = () => env!.store.db
    .prepare("select source, content, trigger_turn from agent_mailbox where thread_id = ? order by created_at")
    .all(thread.id) as Array<{ source: string; content: string; trigger_turn: number }>;
  const texts = () => notes().map((n) => (JSON.parse(n.content) as { text: string }).text);
  /** A file of page/, by its path there (site/… for the page's own). */
  const write = (name: string, body: string | Uint8Array) => {
    fs.mkdirSync(path.dirname(path.join(pageDir, name)), { recursive: true });
    fs.writeFileSync(path.join(pageDir, name), body);
  };
  return { store, pageDir, events, publisher, notes, texts, write, applies: () => applies, updateApplies: () => updateApplies, sse };
}

test("The personal agent's turn that changed site/ publishes a version, quietly", () => {
  const t = publisherEnv();
  t.write("site/index.html", "<h1>Today</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toMatchObject({ revision: 1, pages: { "index.html": "<h1>Today</h1>" }, writer: "agent" });
  const updates = t.events.filter((e) => e.event === "agentPageUpdated");
  expect(updates).toHaveLength(1);
  expect(updates[0]!.data).toMatchObject({ state: { latest: { revision: 1, writer: "agent" }, write: null } });
  expect(t.notes()).toStrictEqual([]);
  // A second edit is the next version.
  t.write("site/index.html", "<h1>Today, later</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(2);
});

test("a turn that left page/ as it was publishes nothing and says nothing", () => {
  const t = publisherEnv();
  // No file at all.
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toBeNull();
  t.write("site/index.html", "<h1>Today</h1>");
  t.write("sources.json", "[]");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.applies()).toBe(1);
  const before = t.events.length;
  // The same bytes again: nothing published, nothing applied, no note.
  t.write("site/index.html", "<h1>Today</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.applies()).toBe(1);
  expect(t.events.length).toBe(before);
  expect(t.notes()).toStrictEqual([]);
});

test("a page over 16 MiB is not published, and the personal agent hears so", () => {
  const t = publisherEnv();
  t.write("site/index.html", "<h1>Small</h1>");
  t.publisher.afterAgentTurn();
  t.write("site/index.html", Buffer.alloc(CANVAS_PAGE_MAX_BYTES + 1, "a"));
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.notes()).toHaveLength(1);
  expect(t.notes()[0]).toMatchObject({ source: "page-result", trigger_turn: 0 });
  expect(t.texts()[0]).toBe("[Page] Your edit was not published: site/ is 16.0 MB, over the 16 MB limit. The last page stays.");
  // Told once: a later turn that left the file as it was says nothing more.
  t.publisher.afterAgentTurn();
  expect(t.notes()).toHaveLength(1);
});

test("any file of site/ changed publishes all of it; what is outside site/ is not the page's", () => {
  const t = publisherEnv();
  const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);
  t.write("site/index.html", '<link rel="stylesheet" href="style.css"><a href="mr.html">MRs</a>');
  t.write("site/mr.html", "<h1>MRs</h1>");
  t.write("site/style.css", "h1{color:red}");
  t.write("backlog.py", "TOKEN = 'x'");
  t.publisher.afterAgentTurn();
  expect(Object.keys(t.store.latest()!.pages)).toEqual(["index.html", "mr.html"]);
  expect(t.store.files(1).map((f) => f.path)).toEqual(["index.html", "mr.html", "style.css"]);
  // Only the stylesheet changed: a new version, the pages as they were.
  t.write("site/style.css", "h1{color:blue}");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(2);
  expect(text(t.store.file(2, "style.css"))).toBe("h1{color:blue}");
  expect(text(t.store.file(1, "style.css"))).toBe("h1{color:red}");
  // A script beside site/ changed: no version, no note.
  t.write("backlog.py", "TOKEN = 'y'");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(2);
  expect(t.notes()).toStrictEqual([]);
});

test("a site/ with no index.html is not published, and the personal agent hears why", () => {
  const t = publisherEnv();
  t.write("site/index.html", "<h1>One</h1>");
  t.publisher.afterAgentTurn();
  fs.renameSync(path.join(t.pageDir, "site", "index.html"), path.join(t.pageDir, "site", "home.html"));
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.texts()).toEqual(["[Page] Your edit was not published: site/ has no index.html. The last page stays."]);
  // Too many files, said the same way.
  for (let i = 0; i < 200; i += 1) t.write(`site/img/${i}.png`, "x");
  t.write("site/index.html", "<h1>Two</h1>");
  t.publisher.afterAgentTurn();
  expect(t.texts()[1]).toBe("[Page] Your edit was not published: site/ holds 202 files, over the limit of 200. The last page stays.");
});

test("a page from before site/, moved into it, publishes nothing new", () => {
  const t = publisherEnv();
  env!.store.db.prepare("insert into agent_page_versions (revision, html, writer, created_at) values (1, '<h1>Old</h1>', 'agent', '2026-11-01T00:00:00.000Z')").run();
  t.write("site/index.html", "<h1>Old</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.events.filter((e) => e.event === "agentPageUpdated")).toHaveLength(0);
  expect(t.notes()).toStrictEqual([]);
});

test("a page subagent's end publishes, and its note says how it ended", () => {
  const t = publisherEnv({ names: ["soil-sensors", "tank-level"], error: null });
  t.store.startWrite("task_a", "Put usage first");
  t.write("site/index.html", "<h1>Usage</h1>");
  t.write("sources.json", "[]");
  t.publisher.afterSubagent({ taskId: "task_a", title: "Put usage first", reply: "Moved the usage chart to the top.", failed: null });
  expect(t.store.latest()).toMatchObject({ revision: 1, writer: "Put usage first" });
  expect(t.store.state().write).toMatchObject({ taskId: "task_a", status: "published", revision: 1 });
  expect(t.texts()[0]).toBe("[Page] Version 1, from the page subagent “Put usage first”: Moved the usage chart to the top.\nSources: soil-sensors, tank-level.");

  // Changed nothing; its long reply is cut to 300 characters.
  t.store.startWrite("task_b", "Check the layout");
  const long = "x".repeat(400);
  t.publisher.afterSubagent({ taskId: "task_b", title: "Check the layout", reply: long, failed: null });
  expect(t.store.state().write).toMatchObject({ taskId: "task_b", status: "unchanged", revision: null });
  expect(t.texts()[1]).toBe(`[Page] The page subagent “Check the layout” changed nothing: ${"x".repeat(300)}…`);

  // Failed: the last page stays, and what it left is not published later.
  t.store.startWrite("task_c", "Add the moisture table");
  t.write("site/index.html", "<h1>Half</h1>");
  t.publisher.afterSubagent({ taskId: "task_c", title: "Add the moisture table", reply: null, failed: "stopped by the user" });
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.store.state().write).toMatchObject({ taskId: "task_c", status: "failed", error: "stopped by the user" });
  expect(t.texts()[2]).toBe("[Page] The page subagent “Add the moisture table” failed: stopped by the user. The last page stays.");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);

  // Quiet, but for the failure: that wakes the personal agent.
  expect(t.notes().map((note) => [note.source, note.trigger_turn])).toEqual([["page-result", 0], ["page-result", 0], ["page-result", 1]]);
  // Each write's start and end is an update the pane hears.
  expect(t.events.filter((e) => e.event === "agentPageUpdated").length).toBeGreaterThanOrEqual(3);
});

test("a changed sources.json is applied; a refused one says so", () => {
  const ok = publisherEnv({ names: [], error: null });
  ok.write("sources.json", "[]");
  ok.publisher.afterAgentTurn();
  expect(ok.applies()).toBe(1);
  // Applied cleanly after the personal agent's own edit: nothing to say.
  expect(ok.notes()).toStrictEqual([]);
  env!.cleanup(); env = null;

  const bad = publisherEnv({ names: null, error: "line 4: Unexpected token" });
  bad.write("sources.json", "[{");
  bad.publisher.afterAgentTurn();
  expect(bad.applies()).toBe(1);
  expect(bad.texts()).toEqual(["[Page] sources.json was not applied: line 4: Unexpected token. The sources before it keep running."]);
  expect(bad.notes()[0]).toMatchObject({ source: "page-result", trigger_turn: 0 });
  // A removed sources.json is a change too: applied, so its sources stop.
  fs.rmSync(path.join(bad.pageDir, "sources.json"));
  bad.publisher.afterAgentTurn();
  expect(bad.applies()).toBe(2);

  // After a page subagent, an empty list reads none, and a refusal is said.
  env!.cleanup(); env = null;
  const sub = publisherEnv({ names: [], error: null });
  sub.store.startWrite("task_a", "Drop the sources");
  sub.write("sources.json", "[]");
  sub.publisher.afterSubagent({ taskId: "task_a", title: "Drop the sources", reply: "Dropped them.", failed: null });
  expect(sub.texts()[0]).toBe("[Page] The page subagent “Drop the sources” changed nothing: Dropped them.\nSources: none.");
});

test("a sources.json that cannot be read is not a missing one: taking it away later is still applied", () => {
  const t = publisherEnv({ names: null, error: "sources.json could not be read" });
  t.write("sources.json", "[]");
  t.publisher.afterAgentTurn();
  expect(t.applies()).toBe(1);
  fs.rmSync(path.join(t.pageDir, "sources.json"));
  fs.mkdirSync(path.join(t.pageDir, "sources.json"));
  t.publisher.afterAgentTurn();
  expect(t.applies()).toBe(2);
  fs.rmSync(path.join(t.pageDir, "sources.json"), { recursive: true });
  t.publisher.afterAgentTurn();
  expect(t.applies()).toBe(3);
});

test("while a page subagent runs, the personal agent's turn end leaves page/ to it: its work in progress is not published", () => {
  const t = publisherEnv();
  t.store.startWrite("task_a", "Rework the layout");
  t.write("site/index.html", "<h1>Half done</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toBeNull();
  expect(t.notes()).toStrictEqual([]);
  t.publisher.afterSubagent({ taskId: "task_a", title: "Rework the layout", reply: "Done.", failed: null });
  expect(t.store.latest()).toMatchObject({ revision: 1, pages: { "index.html": "<h1>Half done</h1>" }, writer: "Rework the layout" });
});

test("a page subagent that never ran leaves page/ as the personal agent has it; one the personal agent stopped is not told of", () => {
  const t = publisherEnv();
  t.write("site/index.html", "<h1>Own edit</h1>");
  t.publisher.afterSubagent({ taskId: "task_q", title: "Queued", reply: null, failed: "you stopped it", tell: false, ran: false });
  expect(t.notes()).toStrictEqual([]);
  // The personal agent's own edit, made meanwhile, is still its to publish.
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toMatchObject({ revision: 1, writer: "agent" });
  // The pane hears the write row end whichever way.
  t.store.startWrite("task_b", "Another");
  t.publisher.afterSubagent({ taskId: "task_b", title: "Another", reply: null, failed: "the user stopped it" });
  expect(t.texts()).toEqual(["[Page] The page subagent “Another” failed: the user stopped it. The last page stays."]);
});

test("a page subagent whose conversation is gone publishes, and nobody is told", () => {
  const t = publisherEnv();
  t.store.startWrite("task_a", "Finish late");
  t.write("site/index.html", "<h1>Late</h1>");
  t.publisher.afterSubagent({ taskId: "task_a", title: "Finish late", reply: "Done.", failed: null, tell: false });
  expect(t.store.latest()?.revision).toBe(1);
  t.store.startWrite("task_b", "Change nothing late");
  t.publisher.afterSubagent({ taskId: "task_b", title: "Change nothing late", reply: "Nothing to do.", failed: null, tell: false });
  expect(t.store.state().write).toMatchObject({ taskId: "task_b", status: "unchanged" });
  expect(t.notes()).toStrictEqual([]);
});

test("a failed page subagent leaves page/ as it was last published: site/ and sources.json put back", () => {
  const running = '[\n  {\n    "name": "soil-sensors",\n    "run": "echo 1",\n    "every": "5m"\n  }\n]\n';
  const t = publisherEnv({ names: ["soil-sensors"], error: null }, () => running);
  const read = (name: string) => fs.readFileSync(path.join(t.pageDir, name), "utf8");
  t.write("site/index.html", "<h1>One</h1>");
  t.write("sources.json", '[{"name":"soil-sensors","run":"echo 1","every":"5m"}]');
  t.publisher.afterAgentTurn();
  expect(t.applies()).toBe(1);
  t.store.startWrite("task_a", "Add the moisture table");
  t.write("site/index.html", "<h1>Half</h1>");
  t.write("sources.json", '[{"name":');
  t.publisher.afterSubagent({ taskId: "task_a", title: "Add the moisture table", reply: null, failed: "the user stopped it" });
  expect(read("site/index.html")).toBe("<h1>One</h1>");
  expect(read("sources.json")).toBe(running);
  expect(t.texts()).toEqual(["[Page] The page subagent “Add the moisture table” failed: the user stopped it. The last page stays."]);
  // Put back is not a change: a later turn publishes and applies nothing.
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.applies()).toBe(1);
  // The personal agent's next edit starts from the published page, not the half one.
  t.write("site/index.html", read("site/index.html").replace("One", "One, edited"));
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toMatchObject({ revision: 2, pages: { "index.html": "<h1>One, edited</h1>" } });
});

test("a failed page subagent's site/ is put back whole: files it changed, added or took away", () => {
  const t = publisherEnv();
  const read = (name: string) => fs.readFileSync(path.join(t.pageDir, name), "utf8");
  t.write("site/index.html", "<h1>One</h1>");
  t.write("site/css/style.css", "h1{color:red}");
  t.write("site/.DS_Store", "finder");
  t.publisher.afterAgentTurn();
  t.store.startWrite("task_a", "Add the MR page");
  t.write("site/css/style.css", "h1{color:");
  t.write("site/mr.html", "<h1>Half</h1>");
  fs.rmSync(path.join(t.pageDir, "site", "index.html"));
  t.publisher.afterSubagent({ taskId: "task_a", title: "Add the MR page", reply: null, failed: "it reached its step limit" });
  expect(read("site/index.html")).toBe("<h1>One</h1>");
  expect(read("site/css/style.css")).toBe("h1{color:red}");
  expect(fs.existsSync(path.join(t.pageDir, "site", "mr.html"))).toBe(false);
  expect(read("site/.DS_Store")).toBe("finder");
  // Put back is not a change.
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
});

test("a first page subagent that failed leaves no half page behind", () => {
  const t = publisherEnv();
  t.store.startWrite("task_a", "First page");
  t.write("site/index.html", "<h1>Half</h1>");
  t.write("sources.json", "[]");
  t.publisher.afterSubagent({ taskId: "task_a", title: "First page", reply: null, failed: "it reached its step limit" });
  expect(fs.readdirSync(path.join(t.pageDir, "site"))).toEqual([]);
  expect(fs.existsSync(path.join(t.pageDir, "sources.json"))).toBe(false);
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toBeNull();
  expect(t.applies()).toBe(0);
});

test("a page/ that cannot be put back is left as it is, and a later turn publishes none of it", () => {
  const t = publisherEnv();
  t.write("site/index.html", "<h1>One</h1>");
  t.publisher.afterAgentTurn();
  t.store.startWrite("task_a", "Rework");
  // A file in site/'s place: no folder to put the page back in.
  fs.rmSync(path.join(t.pageDir, "site"), { recursive: true });
  fs.writeFileSync(path.join(t.pageDir, "site"), "not a folder");
  t.write("sources.json", "[]");
  t.publisher.afterSubagent({ taskId: "task_a", title: "Rework", reply: null, failed: "the user stopped it" });
  expect(t.store.state().write).toMatchObject({ taskId: "task_a", status: "failed" });
  expect(t.texts()).toHaveLength(1);
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.applies()).toBe(0);
});

test("a reply cut for its note is cut between characters, never inside one", () => {
  const t = publisherEnv();
  t.store.startWrite("task_a", "Check the layout");
  t.publisher.afterSubagent({ taskId: "task_a", title: "Check the layout", reply: `${"x".repeat(299)}😀😀`, failed: null });
  expect(t.texts()[0]).toBe(`[Page] The page subagent “Check the layout” changed nothing: ${"x".repeat(299)}😀…`);
  // 300 characters, one of two halves, is not cut.
  t.store.startWrite("task_b", "Check again");
  t.publisher.afterSubagent({ taskId: "task_b", title: "Check again", reply: `${"x".repeat(299)}😀`, failed: null });
  expect(t.texts()[1]).toBe(`[Page] The page subagent “Check again” changed nothing: ${"x".repeat(299)}😀`);
});

test("a page subagent's note wakes the personal agent when the user waited on it or the update failed however it failed; it says which", () => {
  const t = publisherEnv();
  const triggers = () => t.notes().map((n) => n.trigger_turn);
  // On its own, published: a quiet note.
  t.store.startWrite("task_a", "Note the MR");
  t.write("site/index.html", "<h1>One</h1>");
  expect(t.publisher.afterSubagent({ taskId: "task_a", title: "Note the MR", reply: "Done.", failed: null })).toBe(false);
  // Asked for by the user: the note wakes it.
  t.store.startWrite("task_b", "Usage first");
  t.write("site/index.html", "<h1>Two</h1>");
  expect(t.publisher.afterSubagent({ taskId: "task_b", title: "Usage first", reply: "Done.", failed: null, asked: true })).toBe(true);
  // On its own, but its page refused when published: a failure, which wakes it.
  t.store.startWrite("task_c", "Embed the chart");
  t.write("site/index.html", Buffer.alloc(CANVAS_PAGE_MAX_BYTES + 1, "a"));
  expect(t.publisher.afterSubagent({ taskId: "task_c", title: "Embed the chart", reply: "Embedded it.", failed: null })).toBe(true);
  expect(t.store.state().write).toMatchObject({ taskId: "task_c", status: "failed" });
  expect(t.texts()[2]).toBe("[Page] The page subagent “Embed the chart” failed: site/ is 16.0 MB, over the 16 MB limit. The last page stays.");
  expect(triggers()).toEqual([0, 1, 1]);
  // Nobody to tell (the personal agent stopped it itself): no note, no wake.
  t.store.startWrite("task_d", "Stopped");
  expect(t.publisher.afterSubagent({ taskId: "task_d", title: "Stopped", reply: null, failed: "you stopped it", tell: false })).toBe(false);
  expect(triggers()).toEqual([0, 1, 1]);
});

test("a page subagent whose sources.json is refused failed in part: its note wakes the personal agent though nobody waited", () => {
  const t = publisherEnv({ names: null, error: "sources.json does not parse: Unexpected end of JSON input" });
  t.store.startWrite("task_a", "Add a source");
  t.write("site/index.html", "<h1>One</h1>");
  t.write("sources.json", "[{");
  expect(t.publisher.afterSubagent({ taskId: "task_a", title: "Add a source", reply: "Added it.", failed: null })).toBe(true);
  expect(t.notes().map((n) => n.trigger_turn)).toEqual([1]);
  expect(t.texts()[0]).toBe("[Page] Version 1, from the page subagent “Add a source”: Added it.\nsources.json was not applied: sources.json does not parse: Unexpected end of JSON input. The sources before it keep running.");
  // Only sources.json changed, and refused: the same.
  t.store.startWrite("task_b", "Fix the source");
  t.write("sources.json", "[{]");
  expect(t.publisher.afterSubagent({ taskId: "task_b", title: "Fix the source", reply: "Fixed it.", failed: null })).toBe(true);
  expect(t.notes().map((n) => n.trigger_turn)).toEqual([1, 1]);
});

test("a changed updates.json is applied, as sources.json is; a refused one says so, after a page subagent too", () => {
  const t = publisherEnv({ names: [], error: null }, () => "[]\n", { updates: { names: null, error: "update 1: may be due at most once an hour" } });
  t.write("updates.json", '[{"name":"m","when":"*/30 * * * *","task":"x"}]');
  t.publisher.afterAgentTurn();
  expect(t.updateApplies()).toBe(1);
  expect(t.texts()).toEqual(["[Page] updates.json was not applied: update 1: may be due at most once an hour. The updates before it keep running."]);
  // The same file again: nothing applied, nothing said.
  t.publisher.afterAgentTurn();
  expect(t.updateApplies()).toBe(1);
  expect(t.texts()).toHaveLength(1);
  // A page subagent's: its note says so, and wakes the personal agent.
  t.store.startWrite("task_a", "Plan the mornings");
  t.write("updates.json", '[{"name":"m","when":"*/20 * * * *","task":"x"}]');
  expect(t.publisher.afterSubagent({ taskId: "task_a", title: "Plan the mornings", reply: "Listed it.", failed: null })).toBe(true);
  expect(t.texts()[1]).toBe("[Page] The page subagent “Plan the mornings” changed nothing: Listed it.\nupdates.json was not applied: update 1: may be due at most once an hour. The updates before it keep running.");
});

test("a scheduled update's page subagent says nothing to the personal agent when it went well; its failure is told, and wakes it", () => {
  const scheduled = new Map<string, { status: string; error: string | null } | null>([["task_s1", null], ["task_s2", null], ["task_s3", null]]);
  const t = publisherEnv({ names: [], error: null }, () => "[]\n", { scheduled });
  t.store.startWrite("task_s1", "morning-summary");
  t.write("site/index.html", "<h1>Monday</h1>");
  expect(t.publisher.afterSubagent({ taskId: "task_s1", title: "morning-summary", reply: "Summed up Sunday.", failed: null })).toBe(false);
  expect(scheduled.get("task_s1")).toEqual({ status: "updated", error: null });
  expect(t.store.latest()?.revision).toBe(1);
  t.store.startWrite("task_s2", "morning-summary");
  t.publisher.afterSubagent({ taskId: "task_s2", title: "morning-summary", reply: "Nothing new.", failed: null });
  expect(scheduled.get("task_s2")).toEqual({ status: "unchanged", error: null });
  expect(t.notes()).toStrictEqual([]);
  t.store.startWrite("task_s3", "morning-summary");
  expect(t.publisher.afterSubagent({ taskId: "task_s3", title: "morning-summary", reply: null, failed: "it reached its step limit" })).toBe(true);
  expect(scheduled.get("task_s3")).toEqual({ status: "failed", error: "it reached its step limit" });
  expect(t.texts()).toEqual(["[Page] The page subagent “morning-summary” failed: it reached its step limit. The last page stays."]);
  expect(t.notes()[0]).toMatchObject({ trigger_turn: 1 });
});

test("a failed page subagent's updates.json is put back as the updates run", () => {
  const running = '[\n  {\n    "name": "m",\n    "when": "0 9 * * *",\n    "task": "x"\n  }\n]\n';
  const t = publisherEnv({ names: [], error: null }, () => "[]\n", { updatesFile: () => running });
  const read = (name: string) => fs.readFileSync(path.join(t.pageDir, name), "utf8");
  t.write("site/index.html", "<h1>One</h1>");
  t.write("updates.json", '[{"name":"m","when":"0 9 * * *","task":"x"}]');
  t.publisher.afterAgentTurn();
  expect(t.updateApplies()).toBe(1);
  t.store.startWrite("task_a", "Change the times");
  t.write("updates.json", '[{"name":');
  t.publisher.afterSubagent({ taskId: "task_a", title: "Change the times", reply: null, failed: "the user stopped it" });
  expect(read("updates.json")).toBe(running);
  t.publisher.afterAgentTurn();
  expect(t.updateApplies()).toBe(1);
});
