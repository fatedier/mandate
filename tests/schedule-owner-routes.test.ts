import { expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { tempDir } from "./helpers/temp.js";
import { waitUntil } from "./helpers/wait.js";
import { ScheduleStore } from "../src/server/modules/schedules/schedule-store.js";
import { ScheduleManager, type ScheduleClock, type ScheduleRunResult } from "../src/server/modules/schedules/schedule-manager.js";
import { schedulesModule } from "../src/server/modules/schedules/module.js";
import { API_PATHS } from "../src/shared/api-contracts.js";
import type { AppDeps } from "../src/server/app/deps.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";

// The owner's controls on the On duty page: pause, resume and run a check
// now, each told to the personal agent as a note that does not wake it; and a duty
// thread put in or taken out of the sidebar.

const START = Date.parse("2026-11-05T08:20:00.000Z");
const MIN = 60_000;
const QUIET = '{"wake":false}';

function setup(over: { disabled?: boolean } = {}) {
  const env = freshStoresEnv("md-sched-owner-");
  const store = new ScheduleStore(env.store.db);
  let now = START;
  const timers: Array<{ at: number; cb: () => void; done: boolean }> = [];
  const clock: ScheduleClock = {
    now: () => now, setInterval: () => 0, clearInterval: () => {},
    setTimeout: (cb, ms) => { const t = { at: now + ms, cb, done: false }; timers.push(t); return t; },
    clearTimeout: (h) => { (h as { done: boolean }).done = true; }
  };
  let script: () => Partial<ScheduleRunResult> | Promise<Partial<ScheduleRunResult>> = () => ({ stdout: QUIET });
  const told: string[] = [];
  const noted: string[] = [];
  const woke: string[] = [];
  const changed: string[] = [];
  const manager = new ScheduleManager({
    store, agentStore: env.agentStore, dataDir: tempDir("md-sched-owner-data-"), disabled: over.disabled ?? false, clock,
    sse: { emit: () => {} } as unknown as AgentSseEmitter,
    onWake: (threadId) => { woke.push(threadId); return `wake-${woke.length}`; },
    isThreadBusy: () => false,
    tellAgent: (text) => { told.push(text); },
    noteAgent: (text) => { noted.push(text); },
    onScheduleChanged: (threadId) => { changed.push(threadId); },
    openDutyThread: (target) => ({ threadId: "newTitle" in target ? env.agentStore.createManagerThread(target.newTitle).id : target.threadId }),
    runner: { run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, ...(await script()) }) }
  });
  const app = new Hono();
  schedulesModule.mountRoutes!(app, { deps: { schedules: manager } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  const post = async (path: string) => { const res = await app.request(path, { method: "POST" }); return { status: res.status, body: await res.json() as Record<string, unknown> }; };
  return {
    env, store, manager, app, told, noted, woke, changed, post,
    script: (fn: typeof script) => { script = fn; },
    advance: (ms: number) => { now += ms; for (const t of timers) if (!t.done && t.at <= now) { t.done = true; t.cb(); } }
  };
}

async function activeSchedule(s: ReturnType<typeof setup>) {
  const made = await s.manager.create({ name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "Watch the greenhouse.", thread: { newTitle: "greenhouse watch" } });
  if (!("schedule" in made)) throw new Error(`not created: ${JSON.stringify(made)}`);
  await s.manager.settled();
  s.told.length = 0;
  return made.schedule;
}

test("pausing from the page pauses the schedule and tells the personal agent quietly", async () => {
  const s = setup();
  const sch = await activeSchedule(s);
  const r = await s.post(API_PATHS.schedulePause(sch.id));
  expect(r.status).toBe(200);
  expect(r.body.schedule).toMatchObject({ status: "paused", pausedReason: "Paused by the user on the On duty page" });
  expect(s.noted).toEqual(['[Schedule] The user paused "greenhouse daily check" from the On duty page.']);
  expect([s.told, s.woke]).toEqual([[], []]);
  s.manager.dispose();
});

test("resuming from the page resumes it and tells the personal agent quietly", async () => {
  const s = setup();
  const sch = await activeSchedule(s);
  s.manager.pause({ id: sch.id }, "x");
  const r = await s.post(API_PATHS.scheduleResume(sch.id));
  expect(r.status).toBe(200);
  expect(r.body.schedule).toMatchObject({ status: "active", consecutiveFailures: 0 });
  expect(s.noted).toEqual(['[Schedule] The user resumed "greenhouse daily check" from the On duty page.']);
  expect(s.told).toStrictEqual([]);
  s.manager.dispose();
});

test("running from the page runs the check and tells the personal agent quietly", async () => {
  const s = setup();
  const sch = await activeSchedule(s);
  s.advance(5 * MIN);
  const r = await s.post(API_PATHS.scheduleRun(sch.id));
  expect(r.status).toBe(200);
  expect(r.body.schedule).toMatchObject({ id: sch.id, lastOutcome: "manual_quiet", running: false });
  expect(s.store.runs(sch.id, 1)[0]!.outcome).toBe("manual_quiet");
  expect(s.noted).toEqual(['[Schedule] The user ran "greenhouse daily check" now from the On duty page.']);
  expect(s.told).toStrictEqual([]);
  s.manager.dispose();
});

test("run now on a slow check answers running; a second press is refused", async () => {
  const s = setup();
  const sch = await activeSchedule(s);
  s.advance(5 * MIN);
  let release!: (v: Partial<ScheduleRunResult>) => void;
  s.script(() => new Promise((r) => { release = r; }));
  const first = s.manager.ownerRunNow(sch.id);
  await Bun.sleep(0);
  const second = await s.post(API_PATHS.scheduleRun(sch.id));
  expect(second).toEqual({ status: 409, body: { error: expect.any(String), code: "running" } });
  release({ stdout: QUIET });
  expect(await first).toMatchObject({ schedule: { id: sch.id } });
  s.manager.dispose();
});

test("a check still running after 5 s answers running, well inside the server's 10 s; its result follows", async () => {
  const s = setup();
  const sch = await activeSchedule(s);
  s.advance(5 * MIN);
  let release!: (v: Partial<ScheduleRunResult>) => void;
  s.script(() => new Promise((r) => { release = r; }));
  const pending = s.post(API_PATHS.scheduleRun(sch.id));
  await Bun.sleep(0);
  s.advance(5_000);
  expect(await pending).toEqual({ status: 202, body: { status: "running" } });
  expect(s.noted).toEqual(['[Schedule] The user ran "greenhouse daily check" now from the On duty page.']);
  release({ stdout: QUIET });
  await waitUntil(() => s.store.runs(sch.id, 1)[0]?.outcome === "manual_quiet" || null, { timeout: 2000, label: "the check's result" });
  s.manager.dispose();
});

test("each refusal has its code, and none tells the personal agent", async () => {
  const s = setup();
  const sch = await activeSchedule(s);
  expect(await s.post(API_PATHS.scheduleRun("sch_none"))).toEqual({ status: 404, body: { error: expect.any(String), code: "missing" } });
  s.manager.pause({ id: sch.id }, "x");
  expect((await s.post(API_PATHS.scheduleRun(sch.id))).body).toMatchObject({ code: "paused" });
  s.env.agentStore.archiveThread(sch.threadId);
  expect(await s.post(API_PATHS.scheduleResume(sch.id))).toEqual({ status: 409, body: { error: expect.any(String), code: "archived" } });
  expect(s.noted).toStrictEqual([]);
  s.manager.dispose();
  const off = setup({ disabled: true });
  off.store.insert({ threadId: off.env.agentStore.createManagerThread("t").id, name: "n", cron: "0 9 * * *", timezone: "UTC", checkScript: "c", checkTimeoutMs: 60_000, brief: "b", status: "active", nextDueAt: null }, new Date(START).toISOString());
  const id = off.store.all()[0]!.id;
  expect((await off.post(API_PATHS.scheduleRun(id))).body).toMatchObject({ code: "off" });
  off.manager.dispose();
});

test("a duty thread goes in and out of the sidebar; an ordinary thread cannot", async () => {
  const s = setup();
  const sch = await activeSchedule(s);
  s.store.ensureDutyThread(sch.threadId, "investigate", "/tmp/n", new Date(START).toISOString());
  s.changed.length = 0;
  const put = await s.app.request(API_PATHS.dutySidebar(sch.threadId), { method: "PUT" });
  expect([put.status, await put.json()]).toEqual([200, { ok: true }]);
  expect(s.store.sidebarAddedAt(sch.threadId)).toBe(new Date(START).toISOString());
  expect(s.changed).toEqual([sch.threadId]);
  const del = await s.app.request(API_PATHS.dutySidebar(sch.threadId), { method: "DELETE" });
  expect(del.status).toBe(200);
  expect(s.store.sidebarAddedAt(sch.threadId)).toBeNull();
  const ordinary = s.env.agentStore.createManagerThread("Release 3.21").id;
  expect((await s.app.request(API_PATHS.dutySidebar(ordinary), { method: "PUT" })).status).toBe(404);
  // Its last schedule deleted, it is no longer on duty: no sidebar for it.
  s.manager.delete(sch.id);
  expect((await s.app.request(API_PATHS.dutySidebar(sch.threadId), { method: "PUT" })).status).toBe(404);
  s.manager.dispose();
});

test("a check the owner ran, cut off by a change while it ran, says it changed, not that one is running", async () => {
  const s = setup();
  const sch = await activeSchedule(s);
  s.advance(5 * MIN);
  let release!: (v: Partial<ScheduleRunResult>) => void;
  s.script(() => new Promise((r) => { release = r; }));
  const first = s.manager.ownerRunNow(sch.id);
  await Bun.sleep(0);
  // Paused and resumed while its check runs: that check no longer counts.
  s.manager.ownerPause(sch.id);
  s.manager.ownerResume(sch.id);
  release({ stdout: QUIET });
  expect(await first).toEqual({ error: expect.stringContaining("changed while its check ran"), code: "changed" });
  s.manager.dispose();
});
