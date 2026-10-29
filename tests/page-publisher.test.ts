import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { PagePublisher } from "../src/server/modules/page/page-publisher.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { SseEvent } from "../src/shared/api-contracts.js";
import { CANVAS_PAGE_MAX_BYTES } from "../src/shared/canvas-page.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

interface Applied { names: string[] | null; error: string | null }

function publisherEnv(applied: Applied = { names: [], error: null }, sourcesFile = () => "[]\n") {
  env = freshStoresEnv("md-page-publisher-");
  const store = new PageStore(env.store.db);
  const pageDir = path.join(env.dir, "agent", "page");
  fs.mkdirSync(pageDir, { recursive: true });
  const sse = new AgentSseEmitter();
  const events: SseEvent[] = [];
  sse.addSink((e) => events.push(e));
  const thread = env.agentStore.getOrCreateGlobalThread();
  let applies = 0;
  const publisher = new PagePublisher({
    store,
    agentStore: env.agentStore,
    pageDir,
    globalThreadId: () => thread.id,
    applySources: () => { applies += 1; return applied; },
    sourcesFile,
    sse
  });
  const notes = () => env!.store.db
    .prepare("select source, content, trigger_turn from agent_mailbox where thread_id = ? order by created_at")
    .all(thread.id) as Array<{ source: string; content: string; trigger_turn: number }>;
  const texts = () => notes().map((n) => (JSON.parse(n.content) as { text: string }).text);
  const write = (name: string, body: string) => fs.writeFileSync(path.join(pageDir, name), body);
  return { store, pageDir, events, publisher, notes, texts, write, applies: () => applies, sse };
}

test("Your agent's turn that changed index.html publishes a version, quietly", () => {
  const t = publisherEnv();
  t.write("index.html", "<h1>Today</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toMatchObject({ revision: 1, html: "<h1>Today</h1>", writer: "agent" });
  const updates = t.events.filter((e) => e.event === "agentPageUpdated");
  expect(updates).toHaveLength(1);
  expect(updates[0]!.data).toMatchObject({ state: { latest: { revision: 1, writer: "agent" }, write: null } });
  expect(t.notes()).toEqual([]);
  // A second edit is the next version.
  t.write("index.html", "<h1>Today, later</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(2);
});

test("a turn that left page/ as it was publishes nothing and says nothing", () => {
  const t = publisherEnv();
  // No file at all.
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toBeNull();
  t.write("index.html", "<h1>Today</h1>");
  t.write("sources.json", "[]");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.applies()).toBe(1);
  const before = t.events.length;
  // The same bytes again: nothing published, nothing applied, no note.
  t.write("index.html", "<h1>Today</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.applies()).toBe(1);
  expect(t.events.length).toBe(before);
  expect(t.notes()).toEqual([]);
});

test("a page over 16 MiB is not published, and Your agent hears so", () => {
  const t = publisherEnv();
  t.write("index.html", "<h1>Small</h1>");
  t.publisher.afterAgentTurn();
  fs.writeFileSync(path.join(t.pageDir, "index.html"), Buffer.alloc(CANVAS_PAGE_MAX_BYTES + 1, "a"));
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.notes()).toHaveLength(1);
  expect(t.notes()[0]).toMatchObject({ source: "page-result", trigger_turn: 0 });
  expect(t.texts()[0]).toBe("[Page] Your edit was not published: index.html is 16.0 MB, over the 16 MB limit. The last page stays.");
  // Told once: a later turn that left the file as it was says nothing more.
  t.publisher.afterAgentTurn();
  expect(t.notes()).toHaveLength(1);
});

test("a page subagent's end publishes, and its note says how it ended", () => {
  const t = publisherEnv({ names: ["prom-5xx", "gh-pr"], error: null });
  t.store.startWrite("task_a", "Put usage first");
  t.write("index.html", "<h1>Usage</h1>");
  t.write("sources.json", "[]");
  t.publisher.afterSubagent({ taskId: "task_a", title: "Put usage first", reply: "Moved the usage chart to the top.", failed: null });
  expect(t.store.latest()).toMatchObject({ revision: 1, writer: "Put usage first" });
  expect(t.store.state().write).toMatchObject({ taskId: "task_a", status: "published", revision: 1 });
  expect(t.texts()[0]).toBe("[Page] Version 1, from the page subagent “Put usage first”: Moved the usage chart to the top.\nSources: prom-5xx, gh-pr.");

  // Changed nothing; its long reply is cut to 300 characters.
  t.store.startWrite("task_b", "Check the layout");
  const long = "x".repeat(400);
  t.publisher.afterSubagent({ taskId: "task_b", title: "Check the layout", reply: long, failed: null });
  expect(t.store.state().write).toMatchObject({ taskId: "task_b", status: "unchanged", revision: null });
  expect(t.texts()[1]).toBe(`[Page] The page subagent “Check the layout” changed nothing: ${"x".repeat(300)}…`);

  // Failed: the last page stays, and what it left is not published later.
  t.store.startWrite("task_c", "Add the error table");
  t.write("index.html", "<h1>Half</h1>");
  t.publisher.afterSubagent({ taskId: "task_c", title: "Add the error table", reply: null, failed: "stopped by the user" });
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.store.state().write).toMatchObject({ taskId: "task_c", status: "failed", error: "stopped by the user" });
  expect(t.texts()[2]).toBe("[Page] The page subagent “Add the error table” failed: stopped by the user. The last page stays.");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);

  // Quiet, but for the failure: that wakes Your agent.
  expect(t.notes().map((note) => [note.source, note.trigger_turn])).toEqual([["page-result", 0], ["page-result", 0], ["page-result", 1]]);
  // Each write's start and end is an update the pane hears.
  expect(t.events.filter((e) => e.event === "agentPageUpdated").length).toBeGreaterThanOrEqual(3);
});

test("a changed sources.json is applied; a refused one says so", () => {
  const ok = publisherEnv({ names: [], error: null });
  ok.write("sources.json", "[]");
  ok.publisher.afterAgentTurn();
  expect(ok.applies()).toBe(1);
  // Applied cleanly after Your agent's own edit: nothing to say.
  expect(ok.notes()).toEqual([]);
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

test("while a page subagent runs, Your agent's turn end leaves page/ to it: its work in progress is not published", () => {
  const t = publisherEnv();
  t.store.startWrite("task_a", "Rework the layout");
  t.write("index.html", "<h1>Half done</h1>");
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toBeNull();
  expect(t.notes()).toEqual([]);
  t.publisher.afterSubagent({ taskId: "task_a", title: "Rework the layout", reply: "Done.", failed: null });
  expect(t.store.latest()).toMatchObject({ revision: 1, html: "<h1>Half done</h1>", writer: "Rework the layout" });
});

test("a page subagent that never ran leaves page/ as Your agent has it; one Your agent stopped is not told of", () => {
  const t = publisherEnv();
  t.write("index.html", "<h1>Own edit</h1>");
  t.publisher.afterSubagent({ taskId: "task_q", title: "Queued", reply: null, failed: "you stopped it", tell: false, ran: false });
  expect(t.notes()).toEqual([]);
  // Your agent's own edit, made meanwhile, is still its to publish.
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
  t.write("index.html", "<h1>Late</h1>");
  t.publisher.afterSubagent({ taskId: "task_a", title: "Finish late", reply: "Done.", failed: null, tell: false });
  expect(t.store.latest()?.revision).toBe(1);
  t.store.startWrite("task_b", "Change nothing late");
  t.publisher.afterSubagent({ taskId: "task_b", title: "Change nothing late", reply: "Nothing to do.", failed: null, tell: false });
  expect(t.store.state().write).toMatchObject({ taskId: "task_b", status: "unchanged" });
  expect(t.notes()).toEqual([]);
});

test("a failed page subagent leaves page/ as it was last published: index.html and sources.json put back", () => {
  const running = '[\n  {\n    "name": "prom",\n    "run": "echo 1",\n    "every": "5m"\n  }\n]\n';
  const t = publisherEnv({ names: ["prom"], error: null }, () => running);
  const read = (name: string) => fs.readFileSync(path.join(t.pageDir, name), "utf8");
  t.write("index.html", "<h1>One</h1>");
  t.write("sources.json", '[{"name":"prom","run":"echo 1","every":"5m"}]');
  t.publisher.afterAgentTurn();
  expect(t.applies()).toBe(1);
  t.store.startWrite("task_a", "Add the error table");
  t.write("index.html", "<h1>Half</h1>");
  t.write("sources.json", '[{"name":');
  t.publisher.afterSubagent({ taskId: "task_a", title: "Add the error table", reply: null, failed: "the user stopped it" });
  expect(read("index.html")).toBe("<h1>One</h1>");
  expect(read("sources.json")).toBe(running);
  expect(t.texts()).toEqual(["[Page] The page subagent “Add the error table” failed: the user stopped it. The last page stays."]);
  // Put back is not a change: a later turn publishes and applies nothing.
  t.publisher.afterAgentTurn();
  expect(t.store.latest()?.revision).toBe(1);
  expect(t.applies()).toBe(1);
  // Your agent's next edit starts from the published page, not the half one.
  t.write("index.html", read("index.html").replace("One", "One, edited"));
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toMatchObject({ revision: 2, html: "<h1>One, edited</h1>" });
});

test("a first page subagent that failed leaves no half page behind", () => {
  const t = publisherEnv();
  t.store.startWrite("task_a", "First page");
  t.write("index.html", "<h1>Half</h1>");
  t.write("sources.json", "[]");
  t.publisher.afterSubagent({ taskId: "task_a", title: "First page", reply: null, failed: "it reached its step limit" });
  expect(fs.existsSync(path.join(t.pageDir, "index.html"))).toBe(false);
  expect(fs.existsSync(path.join(t.pageDir, "sources.json"))).toBe(false);
  t.publisher.afterAgentTurn();
  expect(t.store.latest()).toBeNull();
  expect(t.applies()).toBe(0);
});

test("a page/ that cannot be put back is left as it is, and a later turn publishes none of it", () => {
  const t = publisherEnv();
  t.write("index.html", "<h1>One</h1>");
  t.publisher.afterAgentTurn();
  t.store.startWrite("task_a", "Rework");
  // Something in index.html's place that no file can be written over.
  fs.rmSync(path.join(t.pageDir, "index.html"));
  fs.mkdirSync(path.join(t.pageDir, "index.html"));
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

test("a page subagent's note wakes Your agent when the user waited on it or the update failed however it failed; it says which", () => {
  const t = publisherEnv();
  const triggers = () => t.notes().map((n) => n.trigger_turn);
  // On its own, published: a quiet note.
  t.store.startWrite("task_a", "Note the MR");
  t.write("index.html", "<h1>One</h1>");
  expect(t.publisher.afterSubagent({ taskId: "task_a", title: "Note the MR", reply: "Done.", failed: null })).toBe(false);
  // Asked for by the user: the note wakes it.
  t.store.startWrite("task_b", "Usage first");
  t.write("index.html", "<h1>Two</h1>");
  expect(t.publisher.afterSubagent({ taskId: "task_b", title: "Usage first", reply: "Done.", failed: null, asked: true })).toBe(true);
  // On its own, but its page refused when published: a failure, which wakes it.
  t.store.startWrite("task_c", "Embed the chart");
  fs.writeFileSync(path.join(t.pageDir, "index.html"), Buffer.alloc(CANVAS_PAGE_MAX_BYTES + 1, "a"));
  expect(t.publisher.afterSubagent({ taskId: "task_c", title: "Embed the chart", reply: "Embedded it.", failed: null })).toBe(true);
  expect(t.store.state().write).toMatchObject({ taskId: "task_c", status: "failed" });
  expect(t.texts()[2]).toBe("[Page] The page subagent “Embed the chart” failed: index.html is 16.0 MB, over the 16 MB limit. The last page stays.");
  expect(triggers()).toEqual([0, 1, 1]);
  // Nobody to tell (Your agent stopped it itself): no note, no wake.
  t.store.startWrite("task_d", "Stopped");
  expect(t.publisher.afterSubagent({ taskId: "task_d", title: "Stopped", reply: null, failed: "you stopped it", tell: false })).toBe(false);
  expect(triggers()).toEqual([0, 1, 1]);
});

test("a page subagent whose sources.json is refused failed in part: its note wakes Your agent though nobody waited", () => {
  const t = publisherEnv({ names: null, error: "sources.json does not parse: Unexpected end of JSON input" });
  t.store.startWrite("task_a", "Add a source");
  t.write("index.html", "<h1>One</h1>");
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
