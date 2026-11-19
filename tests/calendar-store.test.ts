import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { CalendarStore, type CalendarEntryRow } from "../src/server/modules/calendar/calendar-store.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function store(): CalendarStore {
  env = freshStoresEnv("md-calendar-store-");
  return new CalendarStore(env.store.db);
}

function entry(id: string, over: Partial<CalendarEntryRow> = {}): CalendarEntryRow {
  return {
    id, title: `Title ${id}`, note: `Note ${id}`, atMs: null, cron: "0 9 * * 1", timezone: "Asia/Singapore", untilDay: null,
    pausedAt: null, pausedBy: null, skips: [], nextDueMs: 1_000, createdAt: 10, updatedAt: 10, deletedAt: null, deletedBy: null,
    ...over
  };
}

test("an entry is kept whole and read back as written, its skips included", () => {
  const cal = store();
  cal.insert(entry("cal_a", { skips: [5_000, 6_000], untilDay: "2026-12-18", pausedAt: 20, pausedBy: "user" }));
  expect(cal.get("cal_a")).toEqual(entry("cal_a", { skips: [5_000, 6_000], untilDay: "2026-12-18", pausedAt: 20, pausedBy: "user" }));
  expect(cal.get("cal_missing")).toBeNull();
  cal.update("cal_a", { title: "Renamed", skips: [5_000], nextDueMs: null, updatedAt: 30 });
  const read = cal.get("cal_a")!;
  expect([read.title, read.skips, read.nextDueMs, read.updatedAt, read.note]).toEqual(["Renamed", [5_000], null, 30, "Note cal_a"]);
});

test("the live entries leave out the deleted, and the soonest due time leaves out the deleted and the finished", () => {
  const cal = store();
  cal.insert(entry("cal_a", { nextDueMs: 3_000, createdAt: 1 }));
  cal.insert(entry("cal_b", { nextDueMs: 2_000, createdAt: 2, deletedAt: 50, deletedBy: "user" }));
  cal.insert(entry("cal_c", { nextDueMs: null, createdAt: 3 }));
  cal.insert(entry("cal_d", { nextDueMs: 4_000, createdAt: 4 }));
  expect(cal.live().map((row) => row.id)).toEqual(["cal_a", "cal_c", "cal_d"]);
  expect(cal.soonestDue()).toBe(3_000);
  expect(cal.dueBy(3_500).map((row) => row.id)).toEqual(["cal_a"]);
  cal.update("cal_a", { nextDueMs: null });
  cal.update("cal_d", { nextDueMs: null });
  expect(cal.soonestDue()).toBeNull();
});

test("due times are kept per entry, read by range with the entry's title, and newest first per entry", () => {
  const cal = store();
  cal.insert(entry("cal_a"));
  cal.insert(entry("cal_b", { atMs: 9_000, cron: null }));
  cal.insert(entry("cal_gone", { deletedAt: 1, deletedBy: "agent" }));
  cal.addTime({ entryId: "cal_a", dueMs: 1_000, outcome: "delivered", deliveredMs: 1_100, recordedAt: 1_100 });
  cal.addTime({ entryId: "cal_a", dueMs: 2_000, outcome: "missed", deliveredMs: null, recordedAt: 3_100 });
  cal.addTime({ entryId: "cal_b", dueMs: 1_500, outcome: "skipped", deliveredMs: null, recordedAt: 1_500 });
  cal.addTime({ entryId: "cal_gone", dueMs: 1_200, outcome: "delivered", deliveredMs: 1_200, recordedAt: 1_200 });
  expect(cal.timesBetween(0, 10_000).map((t) => [t.entryId, t.title, t.dueMs, t.outcome, t.repeating])).toEqual([
    ["cal_a", "Title cal_a", 1_000, "delivered", true],
    ["cal_b", "Title cal_b", 1_500, "skipped", false],
    ["cal_a", "Title cal_a", 2_000, "missed", true]
  ]);
  expect(cal.timesBetween(1_500, 2_000).map((t) => t.dueMs)).toEqual([1_500]);
  expect(cal.recentTimes("cal_a", 1).map((t) => t.dueMs)).toEqual([2_000]);
  expect(cal.hasTime("cal_a", 1_000)).toBe(true);
  expect(cal.hasTime("cal_a", 1_001)).toBe(false);
});

test("the user's changes are read newest first since a time, with the entry's title, the agent's left out", () => {
  const cal = store();
  cal.insert(entry("cal_a"));
  cal.addChange({ entryId: "cal_a", kind: "pause", by: "user", at: 100, dueMs: null });
  cal.addChange({ entryId: "cal_a", kind: "skip", by: "user", at: 300, dueMs: 9_000 });
  cal.addChange({ entryId: "cal_a", kind: "resume", by: "agent", at: 400, dueMs: null });
  cal.addChange({ entryId: "cal_a", kind: "delete", by: "user", at: 50, dueMs: null });
  expect(cal.userChangesSince(60).map((c) => [c.kind, c.title, c.at, c.dueMs])).toEqual([
    ["skip", "Title cal_a", 300, 9_000],
    ["pause", "Title cal_a", 100, null]
  ]);
});
