import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { pageChangeDigest, PageUpdateManager } from "../src/server/modules/page/page-updates.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { pageFileDigest } from "../src/server/modules/page/page-publisher.js";
import type { SseEvent } from "../src/shared/api-contracts.js";
import { onCleanup } from "./helpers/cleanup.js";

// The page's scheduled updates: updates.json lists them; at each time its
// cron names, a page subagent is started with its task, unless nothing the
// page draws from (nor the personal agent's notes) changed since it last ran.

/** Monday 2026-11-16 08:30 UTC. */
const START = Date.parse("2026-11-16T08:30:00.000Z");

function updatesEnv(over: { digest?: () => string } = {}) {
  const env = freshStoresEnv("md-page-updates-");
  const store = new PageStore(env.store.db);
  const pageDir = path.join(env.dir, "agent", "page");
  fs.mkdirSync(pageDir, { recursive: true });
  const sse = new AgentSseEmitter();
  const events: SseEvent[] = [];
  sse.addSink((e) => events.push(e));
  let now = START;
  let world = "w1";
  const started: Array<{ title: string; task: string; id: string }> = [];
  const open = new Set<string>();
  const updates = new PageUpdateManager({
    db: env.store.db,
    pageDir,
    store,
    sse,
    timeZone: () => "UTC",
    startRun: (title, task) => {
      const id = `task_${started.length + 1}`;
      started.push({ title, task, id });
      open.add(id);
      return id;
    },
    runOpen: (taskId) => open.has(taskId),
    changeDigest: async () => over.digest?.() ?? world,
    now: () => now
  });
  onCleanup(() => updates.dispose());
  const write = (listed: unknown) => fs.writeFileSync(path.join(pageDir, "updates.json"), typeof listed === "string" ? listed : JSON.stringify(listed));
  const at = (iso: string) => { now = Date.parse(iso); };
  /** The run a page subagent made ends. */
  const end = (id: string, outcome: "updated" | "unchanged" | "failed", error: string | null = null) => {
    open.delete(id);
    return updates.runEnded(id, outcome, error);
  };
  return { env, store, pageDir, events, updates, write, at, started, end, setWorld: (w: string) => { world = w; } };
}

const MORNING = { name: "morning-summary", when: "0 9 * * *", task: "Sum up yesterday at the top of the first page." };
const MRS = { name: "mr-notes", when: "0 */2 * * 1-5", task: "Refresh the notes on each MR." };

test("updates.json lists the updates: each with when it runs next, in words where it can be", () => {
  const t = updatesEnv();
  t.write([MORNING, MRS]);
  expect(t.updates.applyFile()).toEqual({ names: ["morning-summary", "mr-notes"], error: null });
  expect(t.updates.list()).toEqual([
    { name: "morning-summary", when: "0 9 * * *", whenText: "Daily 09:00", task: MORNING.task, paused: false, nextRunAt: "2026-11-16T09:00:00.000Z", lastRunAt: null, lastOutcome: null, lastError: null },
    { name: "mr-notes", when: "0 */2 * * 1-5", whenText: "cron 0 */2 * * 1-5", task: MRS.task, paused: false, nextRunAt: "2026-11-16T10:00:00.000Z", lastRunAt: null, lastOutcome: null, lastError: null }
  ]);
  // The list, whole, to whoever shows it.
  expect(t.events.filter((e) => e.event === "agentPageUpdatesChanged").at(-1)?.data).toMatchObject({ updates: [{ name: "morning-summary" }, { name: "mr-notes" }] });
  // No file: no updates.
  fs.rmSync(path.join(t.pageDir, "updates.json"));
  expect(t.updates.applyFile()).toEqual({ names: [], error: null });
  expect(t.updates.list()).toEqual([]);
});

test("an updates.json wrong in any way changes nothing and says why", () => {
  const t = updatesEnv();
  t.write([MORNING]);
  t.updates.applyFile();
  const refused = (listed: unknown) => {
    t.write(listed);
    return t.updates.applyFile();
  };
  expect(refused([MORNING, { ...MRS, when: "0 9 * *" }])).toEqual({ names: null, error: 'update 2: when "0 9 * *" is not a 5-field cron expression' });
  expect(refused([{ ...MORNING, when: "*/30 * * * *" }])).toEqual({ names: null, error: "update 1: may be due at most once an hour" });
  expect(refused([MORNING, MORNING])).toEqual({ names: null, error: "a duplicate name, morning-summary" });
  expect(refused(Array.from({ length: 12 }, (_, i) => ({ ...MORNING, name: `u${i}` })))).toEqual({ names: null, error: "at most 10 updates, not 12" });
  expect(refused([{ ...MORNING, name: "a b" }]).error).toBe('update 1: name "a b" may use only letters, digits, - and _ (at most 40)');
  expect(refused([{ ...MORNING, task: "" }]).error).toBe("update 1: task must be text");
  expect(refused([{ ...MORNING, task: "x".repeat(2001) }]).error).toBe("update 1: task is over 2000 characters");
  expect(refused([{ name: "x" }]).error).toBe("update 1: when must be a 5-field cron expression");
  expect(refused(["x"]).error).toBe("update 1: must be an object with name, when and task");
  expect(refused({ updates: [] }).error).toBe("updates.json must be a list of updates");
  expect(refused("[{").error).toStartWith("updates.json does not parse: ");
  // The updates before it are as they were.
  expect(t.updates.list().map((u) => u.name)).toEqual(["morning-summary"]);
});

test("at its time an update starts a page subagent with its task, then waits for its next time", async () => {
  const t = updatesEnv();
  t.write([MORNING]);
  t.updates.applyFile();
  await t.updates.runDue();
  expect(t.started).toEqual([]);
  t.at("2026-11-16T09:00:10.000Z");
  await t.updates.runDue();
  expect(t.started).toEqual([{ title: "morning-summary", task: MORNING.task, id: "task_1" }]);
  expect(t.updates.list()[0]).toMatchObject({ nextRunAt: "2026-11-17T09:00:00.000Z", lastOutcome: null });
  // It ended: how it went, and when.
  t.at("2026-11-16T09:03:00.000Z");
  expect(t.end("task_1", "updated")).toBe(true);
  expect(t.updates.list()[0]).toMatchObject({ lastRunAt: "2026-11-16T09:03:00.000Z", lastOutcome: "updated", lastError: null });
  // A page subagent of nobody's update is not its.
  expect(t.updates.runEnded("task_other", "updated", null)).toBe(false);
});

test("when nothing changed since an update last ran, its time is skipped; a change, or a failure before, runs it", async () => {
  const t = updatesEnv();
  t.write([MORNING]);
  t.updates.applyFile();
  t.at("2026-11-16T09:00:00.000Z");
  await t.updates.runDue();
  t.end("task_1", "updated");
  // The next morning, nothing moved: no run, said as nothing changed.
  t.at("2026-11-17T09:00:00.000Z");
  await t.updates.runDue();
  expect(t.started).toHaveLength(1);
  expect(t.updates.list()[0]).toMatchObject({ lastRunAt: "2026-11-17T09:00:00.000Z", lastOutcome: "unchanged", nextRunAt: "2026-11-18T09:00:00.000Z" });
  // Something moved: it runs.
  t.setWorld("w2");
  t.at("2026-11-18T09:00:00.000Z");
  await t.updates.runDue();
  expect(t.started).toHaveLength(2);
  // It failed: the next time runs again though nothing moved since.
  t.end("task_2", "failed", "it reached its step limit");
  expect(t.updates.list()[0]).toMatchObject({ lastOutcome: "failed", lastError: "it reached its step limit" });
  t.at("2026-11-19T09:00:00.000Z");
  await t.updates.runDue();
  expect(t.started).toHaveLength(3);
});

test("a time missed while Mandate was down runs once; one that comes while its last run is still going is skipped", async () => {
  const t = updatesEnv({ digest: () => String(Math.random()) });
  t.write([{ ...MORNING, when: "0 * * * *" }]);
  t.updates.applyFile();
  // Five hours later at once: one run, then the next hour.
  t.at("2026-11-16T14:20:00.000Z");
  await t.updates.runDue();
  await t.updates.runDue();
  expect(t.started).toHaveLength(1);
  expect(t.updates.list()[0]!.nextRunAt).toBe("2026-11-16T15:00:00.000Z");
  // Still running at 15:00: that time goes by.
  t.at("2026-11-16T15:00:00.000Z");
  await t.updates.runDue();
  expect(t.started).toHaveLength(1);
  expect(t.updates.list()[0]!.nextRunAt).toBe("2026-11-16T16:00:00.000Z");
});

test("paused, an update does not run; resumed, it waits for its next time; listed again, it stays paused", async () => {
  const t = updatesEnv();
  t.write([MORNING]);
  t.updates.applyFile();
  expect(t.updates.setPaused("morning-summary", true)).toMatchObject({ paused: true });
  t.at("2026-11-16T09:00:00.000Z");
  await t.updates.runDue();
  expect(t.started).toEqual([]);
  t.write([{ ...MORNING, task: "Sum up yesterday, briefly." }]);
  t.updates.applyFile();
  expect(t.updates.list()[0]).toMatchObject({ paused: true, task: "Sum up yesterday, briefly." });
  t.at("2026-11-16T10:00:00.000Z");
  expect(t.updates.setPaused("morning-summary", false)).toMatchObject({ paused: false, nextRunAt: "2026-11-17T09:00:00.000Z" });
  await t.updates.runDue();
  expect(t.started).toEqual([]);
  expect(t.updates.setPaused("nobody", true)).toBeNull();
});

test("a removed update is taken out of updates.json, which then needs no applying again", () => {
  const t = updatesEnv();
  t.write([MORNING, MRS]);
  t.updates.applyFile();
  // As the publisher keeps it once applied.
  const file = path.join(t.pageDir, "updates.json");
  t.store.setFileDigest("updates.json", pageFileDigest(fs.readFileSync(file, "utf8")));
  expect(t.updates.remove("mr-notes")).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([MORNING]);
  expect(t.store.fileDigest("updates.json")).toBe(pageFileDigest(fs.readFileSync(file, "utf8")));
  expect(t.updates.list().map((u) => u.name)).toEqual(["morning-summary"]);
  expect(t.updates.remove("mr-notes")).toBe(false);
  // What the running updates are, as a file: applied, it changes nothing.
  expect(JSON.parse(t.updates.fileText())).toEqual([MORNING]);
});

test("the change digest moves with the data read and with the notes, and with nothing else", async () => {
  const env = freshStoresEnv("md-page-change-");
  const notesDir = path.join(env.dir, "notes");
  fs.mkdirSync(path.join(notesDir, "matters"), { recursive: true });
  fs.writeFileSync(path.join(notesDir, "index.md"), "- release");
  let data: unknown = { threads: [{ id: "thr_1", state: "working" }] };
  const digest = () => pageChangeDigest({ data: async () => data, notesDir });
  const first = await digest();
  expect(await digest()).toBe(first);
  fs.writeFileSync(path.join(notesDir, "matters", "release.md"), "Waiting on the MR.");
  const noted = await digest();
  expect(noted).not.toBe(first);
  data = { threads: [{ id: "thr_1", state: "needs_you" }] };
  expect(await digest()).not.toBe(noted);
  // No notes folder at all is no change either.
  fs.rmSync(notesDir, { recursive: true });
  const none = await digest();
  expect(await digest()).toBe(none);
});

test("a removal leaves updates.json due when what is left is not what runs: a refused edit in it is applied later", () => {
  const t = updatesEnv();
  const file = path.join(t.pageDir, "updates.json");
  t.write([MORNING, MRS]);
  t.updates.applyFile();
  // An edit refused: the morning's task changed, the MR notes' cron wrong.
  t.write([{ ...MORNING, task: "Sum up the week." }, { ...MRS, when: "0 9 * *" }]);
  expect(t.updates.applyFile().error).not.toBeNull();
  t.store.setFileDigest("updates.json", pageFileDigest(fs.readFileSync(file, "utf8")));
  // The user removes the broken one: what is left is right, and not what runs.
  t.updates.remove("mr-notes");
  expect(t.store.fileDigest("updates.json")).not.toBe(pageFileDigest(fs.readFileSync(file, "utf8")));
  expect(t.updates.applyFile()).toEqual({ names: ["morning-summary"], error: null });
  expect(t.updates.list()[0]!.task).toBe("Sum up the week.");
});

test("a run whose update was removed while it went is still the update's when it ends", async () => {
  const t = updatesEnv();
  t.write([MORNING]);
  t.updates.applyFile();
  t.at("2026-11-16T09:00:00.000Z");
  await t.updates.runDue();
  t.updates.remove("morning-summary");
  expect(t.end("task_1", "updated")).toBe(true);
  // Told once only.
  expect(t.updates.runEnded("task_1", "updated", null)).toBe(false);
});

test("a run's update is known from the run itself, kept with it until it ends: through a removal and a restart", async () => {
  const t = updatesEnv();
  t.write([MORNING]);
  t.updates.applyFile();
  t.at("2026-11-16T09:00:00.000Z");
  await t.updates.runDue();
  t.updates.remove("morning-summary");
  // Mandate restarts: a new manager over the same table.
  const again = new PageUpdateManager({
    db: t.env.store.db, pageDir: t.pageDir, store: t.store, sse: new AgentSseEmitter(), timeZone: () => "UTC",
    startRun: () => null, runOpen: () => false, changeDigest: async () => "w1"
  });
  expect(again.runEnded("task_1", "updated", null)).toBe(true);
  expect(again.runEnded("task_1", "updated", null)).toBe(false);
});
