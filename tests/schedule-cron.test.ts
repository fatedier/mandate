import { expect, test } from "bun:test";
import { describeCron, nextDue, ScheduleRefusal } from "../src/server/modules/schedules/cron.js";

test("the next due time follows the cron in its time zone", () => {
  expect(nextDue("0 9 * * *", "Asia/Singapore", new Date("2026-11-04T08:20:00.000Z")).toISOString()).toBe("2026-11-05T01:00:00.000Z");
  expect(nextDue("*/15 * * * *", "UTC", new Date("2026-11-04T08:20:00.000Z")).toISOString()).toBe("2026-11-04T08:30:00.000Z");
});

test("a time the clocks skip runs at the next real time, then the cron resumes", () => {
  // 02:30 does not exist in New York on 2026-03-08: croner runs it at 03:30 EDT.
  const first = nextDue("30 2 * * *", "America/New_York", new Date("2026-03-07T12:00:00.000Z"));
  expect(first.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  expect(nextDue("30 2 * * *", "America/New_York", first).toISOString()).toBe("2026-03-09T06:30:00.000Z");
});

test("the hour the clocks repeat never yields a time already past", () => {
  // 01:30 comes twice in New York on 2026-11-01; at 01:15 EST croner's own
  // answer is the first 01:30 (EDT), 45 minutes back.
  const after = new Date("2026-11-01T06:15:00.000Z");
  const next = nextDue("30 1 * * *", "America/New_York", after);
  expect(next.getTime()).toBeGreaterThan(after.getTime());
  expect(next.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  const quarter = nextDue("*/15 * * * *", "America/New_York", after);
  expect(quarter.getTime()).toBeGreaterThan(after.getTime());
});

test("a bad cron or zone is refused with what is wrong", () => {
  expect(() => nextDue("61 9 * * *", "UTC", new Date())).toThrow(ScheduleRefusal);
  expect(() => nextDue("0 0 9 * * *", "UTC", new Date())).toThrow(/5/);
  expect(() => nextDue("0 9 * * *", "Nope/Zone", new Date())).toThrow(ScheduleRefusal);
});

test("common crons read in words, the rest as they are", () => {
  expect(describeCron("0 9 * * *")).toBe("Daily 09:00");
  expect(describeCron("30 18 * * *")).toBe("Daily 18:30");
  expect(describeCron("0 9 * * 1-5")).toBe("Weekdays 09:00");
  expect(describeCron("0 * * * *")).toBe("Hourly");
  expect(describeCron("*/15 * * * *")).toBe("Every 15 min");
  expect(describeCron("0 9 1 * *")).toBe("cron 0 9 1 * *");
  expect(describeCron(" 0  9 * * * ")).toBe("Daily 09:00");
});
