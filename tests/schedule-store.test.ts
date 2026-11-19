import { expect, test } from "bun:test";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { ScheduleStore, type NewSchedule } from "../src/server/modules/schedules/schedule-store.js";

const AT = "2026-11-04T08:21:00.000Z";

function setup() {
  const env = freshStoresEnv("md-sched-store-");
  const store = new ScheduleStore(env.store.db);
  const thread = env.agentStore.createManagerThread("greenhouse watch");
  const input = (over: Partial<NewSchedule> = {}): NewSchedule => ({
    threadId: thread.id, name: "greenhouse daily check", cron: "0 9 * * *", timezone: "Asia/Singapore",
    checkScript: "echo '{\"wake\":false}'", checkTimeoutMs: 60_000, brief: "Watch the greenhouse.",
    status: "active", nextDueAt: "2026-11-05T01:00:00.000Z", ...over
  });
  return { env, store, thread, input };
}

test("a schedule reads back as written", () => {
  const s = setup();
  const row = s.store.insert(s.input(), AT);
  expect(row.id).toMatch(/^sch_/);
  expect(s.store.get(row.id)).toMatchObject({
    threadId: s.thread.id, name: "greenhouse daily check", cron: "0 9 * * *", timezone: "Asia/Singapore",
    status: "active", nextDueAt: "2026-11-05T01:00:00.000Z", consecutiveFailures: 0, checkStateJson: "{}",
    seenItemsJson: "[]", pendingWakeJson: null, revision: 0, createdAt: AT
  });
  expect(s.store.byThread(s.thread.id).map((r) => r.id)).toEqual([row.id]);
});

test("an update against a stale revision changes nothing", () => {
  const s = setup();
  const row = s.store.insert(s.input(), AT);
  expect(s.store.update(row.id, { lastOutcome: "quiet" }, { at: AT, expectRevision: 0 })).toBe(true);
  expect(s.store.update(row.id, { lastOutcome: "woke" }, { at: AT, expectRevision: 0 })).toBe(false);
  expect(s.store.get(row.id)).toMatchObject({ lastOutcome: "quiet", revision: 1 });
});

test("only active schedules are due", () => {
  const s = setup();
  const due = s.store.insert(s.input({ nextDueAt: "2026-11-04T08:00:00.000Z" }), AT);
  s.store.insert(s.input({ nextDueAt: "2026-11-04T08:00:00.000Z", status: "paused" }), AT);
  s.store.insert(s.input({ nextDueAt: "2026-11-05T08:00:00.000Z" }), AT);
  expect(s.store.due(AT).map((r) => r.id)).toEqual([due.id]);
});

test("runs older than a week keep only the newest 200 per schedule, newest first", () => {
  const s = setup();
  const row = s.store.insert(s.input(), AT);
  const other = s.store.insert(s.input(), AT);
  const OLD = "2026-10-01T00:00:00.000Z";
  s.store.recordRun({ scheduleId: other.id, threadId: s.thread.id, dueAt: OLD, startedAt: OLD, finishedAt: OLD, outcome: "quiet", exitCode: 0, durationMs: 5, line: "other", missed: 0 });
  for (let i = 0; i < 204; i++) {
    s.store.recordRun({ scheduleId: row.id, threadId: s.thread.id, dueAt: OLD, startedAt: OLD, finishedAt: OLD, outcome: "quiet", exitCode: 0, durationMs: i, line: `run ${i}`, missed: 0 });
  }
  // A run today prunes against a week before it: the old ones beyond 200 go.
  s.store.recordRun({ scheduleId: row.id, threadId: s.thread.id, dueAt: AT, startedAt: AT, finishedAt: AT, outcome: "quiet", exitCode: 0, durationMs: 204, line: "run 204", missed: 0 });
  const runs = s.store.runs(row.id, 500);
  expect(runs).toHaveLength(200);
  expect(runs[0]!.line).toBe("run 204");
  expect(runs.at(-1)!.line).toBe("run 5");
  expect(s.store.runs(other.id, 10)).toHaveLength(1);
});

test("a week of runs is kept however many there are, so a week's counts are whole", () => {
  const s = setup();
  const row = s.store.insert(s.input(), AT);
  const base = Date.parse(AT);
  for (let i = 0; i < 250; i++) {
    const at = new Date(base - i * 60_000).toISOString();
    s.store.recordRun({ scheduleId: row.id, threadId: s.thread.id, dueAt: at, startedAt: at, finishedAt: at, outcome: i === 240 ? "woke" : "quiet", exitCode: 0, durationMs: 1, line: "", missed: 0 });
  }
  expect(s.store.runCountsSince(row.id, new Date(base - 7 * 24 * 3_600_000).toISOString())).toEqual({ runs: 250, wakes: 1 });
});

test("a thread is a duty thread while it has a schedule, paused included", () => {
  const s = setup();
  expect(s.store.isDutyThread(s.thread.id)).toBe(false);
  const row = s.store.insert(s.input({ status: "paused" }), AT);
  expect(s.store.isDutyThread(s.thread.id)).toBe(true);
  s.store.delete(row.id);
  expect(s.store.isDutyThread(s.thread.id)).toBe(false);
});

test("deleting a schedule takes its runs", () => {
  const s = setup();
  const row = s.store.insert(s.input(), AT);
  s.store.recordRun({ scheduleId: row.id, threadId: s.thread.id, dueAt: AT, startedAt: AT, finishedAt: AT, outcome: "quiet", exitCode: 0, durationMs: 1, line: "", missed: 0 });
  s.store.delete(row.id);
  expect(s.store.get(row.id)).toBeNull();
  expect(s.store.runs(row.id, 10)).toStrictEqual([]);
});

test("a duty thread keeps one level and what it last told", () => {
  const s = setup();
  expect(s.store.dutyThread(s.thread.id)).toBeNull();
  s.store.ensureDutyThread(s.thread.id, "investigate", "/d/notes", AT);
  s.store.ensureDutyThread(s.thread.id, "fix_for_review", "/other", AT);
  expect(s.store.dutyThread(s.thread.id)).toMatchObject({ level: "investigate", notesDir: "/d/notes", lastToldSeq: 0 });
  s.store.setLevel(s.thread.id, "fix_for_review");
  s.store.setLastToldSeq(s.thread.id, 42);
  expect(s.store.dutyThread(s.thread.id)).toMatchObject({ level: "fix_for_review", lastToldSeq: 42 });
});

test("report outcomes read back only for stored replies", () => {
  const s = setup();
  s.store.recordReport("msg_a", s.thread.id, "sent", AT);
  s.store.recordReport("msg_b", s.thread.id, "no_report", AT);
  const got = s.store.reportsFor(["msg_a", "msg_b", "msg_c"]);
  expect([...got.entries()]).toEqual([["msg_a", "sent"], ["msg_b", "no_report"]]);
  expect(s.store.reportsFor([]).size).toBe(0);
});

test("a schedule counts the checks that ran, however many runs are kept", () => {
  const s = setup();
  const row = s.store.insert(s.input(), AT);
  const OLD = "2026-10-01T00:00:00.000Z";
  const run = (outcome: Parameters<typeof s.store.recordRun>[0]["outcome"], at = AT) =>
    s.store.recordRun({ scheduleId: row.id, threadId: s.thread.id, dueAt: at, startedAt: at, finishedAt: at, outcome, exitCode: 0, durationMs: 1, line: "", missed: 0 });
  for (let i = 0; i < 205; i++) run("quiet", OLD);
  for (const outcome of ["woke", "failed", "manual_quiet", "manual_woke"] as const) run(outcome);
  // A trial and a skipped due time are not checks of the schedule's.
  for (const outcome of ["test", "skipped_overlap", "skipped_floor"] as const) run(outcome);
  expect(s.store.runs(row.id, 500).length).toBeLessThan(212);
  expect(s.store.get(row.id)!.checksRun).toBe(209);
});
