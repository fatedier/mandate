import { expect, test } from "bun:test";
import { CalendarRefusal, checkRepeat, dayOf, dayStart, dueTimesBetween, repeatWords } from "../src/server/modules/calendar/calendar-rules.js";
import { ScheduleRefusal } from "../src/server/modules/schedules/cron.js";

function refusal(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (err) {
    return err instanceof CalendarRefusal || err instanceof ScheduleRefusal ? err.message : `other: ${String(err)}`;
  }
}

const at = (iso: string) => Date.parse(iso);

test("a repeat of a common shape is said in words, anything else as its cron", () => {
  expect(repeatWords("0 8 * * *")).toBe("Daily 08:00");
  expect(repeatWords("30 9 * * 1-5")).toBe("Weekdays 09:30");
  expect(repeatWords("0 9 * * 1")).toBe("Every Monday 09:00");
  expect(repeatWords("0 9 * * 0")).toBe("Every Sunday 09:00");
  expect(repeatWords("0 9 * * 7")).toBe("Every Sunday 09:00");
  expect(repeatWords("0 9 * * MON")).toBe("Every Monday 09:00");
  expect(repeatWords("0 9 * * 1,3")).toBe("Every Mon, Wed 09:00");
  expect(repeatWords("0 10 1 * *")).toBe("Monthly on the 1st, 10:00");
  expect(repeatWords("0 10 22 * *")).toBe("Monthly on the 22nd, 10:00");
  expect(repeatWords("0 10 13 * *")).toBe("Monthly on the 13th, 10:00");
  expect(repeatWords("0 17 L * *")).toBe("Last day of the month, 17:00");
  expect(repeatWords("0 10 * * 1#1")).toBe("First Monday of the month, 10:00");
  expect(repeatWords("0 10 * * 5#3")).toBe("Third Friday of the month, 10:00");
  expect(repeatWords("0 10 15 */3 *")).toBe("Every 3 months on the 15th, 10:00");
  expect(repeatWords("0 10 15 3,6,9,12 *")).toBe("cron 0 10 15 3,6,9,12 *");
  // A step that does not divide the year comes round unevenly at the year's end.
  expect(repeatWords("0 10 15 */2 *")).toBe("Every 2 months on the 15th, 10:00");
  expect(repeatWords("0 10 15 */5 *")).toBe("cron 0 10 15 */5 *");
  expect(repeatWords("0 10 15 */7 *")).toBe("cron 0 10 15 */7 *");
  expect(repeatWords("0 */2 * * *")).toBe("cron 0 */2 * * *");
  expect(repeatWords("  0   8 * * *  ")).toBe("Daily 08:00");
});

test("a repeat that can come due twice within an hour is refused, an hourly one is not", () => {
  const from = at("2026-11-13T07:40:00Z");
  const tight = "A repeat may be due at most once an hour.";
  expect(refusal(() => checkRepeat("*/30 * * * *", "Asia/Singapore", from))).toBe(tight);
  expect(refusal(() => checkRepeat("0,30 9 * * 1", "Asia/Singapore", from))).toBe(tight);
  expect(refusal(() => checkRepeat("59 8 * * *", "Asia/Singapore", from))).toBeNull();
  expect(refusal(() => checkRepeat("0,59 9 * * *", "Asia/Singapore", from))).toBe(tight);
  expect(refusal(() => checkRepeat("0 8,9 * * *", "Asia/Singapore", from))).toBeNull();
  // Looked at between two of an hour's minutes, the hour's last one comes first.
  expect(refusal(() => checkRepeat("0,30 9 * * *", "UTC", at("2026-11-13T09:10:00Z")))).toBe(tight);
  expect(refusal(() => checkRepeat("* 9 * * *", "UTC", at("2026-11-13T09:58:30Z")))).toBe(tight);
  expect(refusal(() => checkRepeat("0 * * * *", "Asia/Singapore", from))).toBeNull();
  // Lord Howe moves its clocks by half an hour: an hourly repeat comes due 30 minutes apart
  // on 3 Oct 2027, more than 2,000 hours ahead but inside the 400 days looked at.
  expect(refusal(() => checkRepeat("0 * * * *", "Australia/Lord_Howe", at("2026-11-13T00:00:00Z")))).toBe(tight);
  expect(refusal(() => checkRepeat("0 9 * * 1-5", "Asia/Singapore", from))).toBeNull();
  expect(refusal(() => checkRepeat("0 10 15 */3 *", "Asia/Singapore", from))).toBeNull();
  expect(refusal(() => checkRepeat("0 9 * *", "Asia/Singapore", from))).toMatch(/^not a 5-field cron expression/);
  expect(refusal(() => checkRepeat("0 9 * * 1", "Mars/Olympus", from))).toMatch(/^not a time zone/);
});

test("a once rule is due at its time when the range holds it", () => {
  const rule = { atMs: at("2026-11-17T02:00:00Z"), cron: null, timezone: "Asia/Singapore", untilDay: null };
  expect(dueTimesBetween(rule, at("2026-11-16T00:00:00Z"), at("2026-11-18T00:00:00Z"))).toEqual([rule.atMs]);
  expect(dueTimesBetween(rule, at("2026-11-17T02:00:00Z"), at("2026-11-18T00:00:00Z"))).toEqual([rule.atMs]);
  expect(dueTimesBetween(rule, at("2026-11-16T00:00:00Z"), at("2026-11-17T02:00:00Z"))).toEqual([]);
});

test("a weekly repeat is due each week in its zone, through its until day", () => {
  const rule = { atMs: null, cron: "0 9 * * 1", timezone: "Asia/Singapore", untilDay: null };
  expect(dueTimesBetween(rule, at("2026-11-13T00:00:00Z"), at("2026-11-27T00:00:00Z")))
    .toEqual([at("2026-11-16T01:00:00Z"), at("2026-11-23T01:00:00Z")]);
  // The until day counts whole, in the rule's zone: 23 Nov 09:00 Singapore is due, 30 Nov is not.
  const ending = { ...rule, untilDay: "2026-11-23" };
  expect(dueTimesBetween(ending, at("2026-11-13T00:00:00Z"), at("2026-12-10T00:00:00Z")))
    .toEqual([at("2026-11-16T01:00:00Z"), at("2026-11-23T01:00:00Z")]);
});

test("a time in a daylight-saving gap or repeated hour is due once that day", () => {
  const rule = { atMs: null, cron: "30 1 * * *", timezone: "America/New_York", untilDay: null };
  // 1 Nov 2026: 01:00–02:00 happens twice in New York.
  const fall = dueTimesBetween(rule, at("2026-10-31T12:00:00Z"), at("2026-11-02T12:00:00Z"));
  expect(fall.map((ms) => dayOf(ms, "America/New_York"))).toEqual(["2026-11-01", "2026-11-02"]);
  // 8 Mar 2026: 02:00–03:00 does not happen; 02:30 is due once that day, moved
  // into the hour after the gap (03:30 EDT), neither skipped nor twice.
  const gap = { ...rule, cron: "30 2 * * *" };
  const spring = dueTimesBetween(gap, at("2026-03-07T12:00:00Z"), at("2026-03-09T12:00:00Z"));
  expect(spring.map((ms) => dayOf(ms, "America/New_York"))).toEqual(["2026-03-08", "2026-03-09"]);
  expect(spring[0]).toBe(at("2026-03-08T07:30:00Z"));
});

// Croner moves a time in the gap to the hour after it only when it walks from
// before the gap: walked from the moved time itself it found the next day's.
test("a time moved out of a daylight-saving gap is found from wherever the walk starts, the moved time itself too", () => {
  const rule = { atMs: null, cron: "30 2 * * *", timezone: "America/New_York", untilDay: null };
  const moved = at("2027-03-14T07:30:00Z"); // 03:30 EDT on 14 Mar 2027
  for (const from of [at("2027-03-13T08:00:00Z"), at("2027-03-14T06:59:00Z"), at("2027-03-14T07:00:00Z"), moved]) {
    expect(dueTimesBetween(rule, from, at("2027-03-16T00:00:00Z"))).toEqual([moved, at("2027-03-15T06:30:00Z")]);
  }
  expect(dueTimesBetween(rule, moved, moved + 1)).toEqual([moved]);
  expect(dueTimesBetween(rule, moved + 1, at("2027-03-16T00:00:00Z"))).toEqual([at("2027-03-15T06:30:00Z")]);
});

test("a day in a zone starts at its local midnight, and a day is named in that zone", () => {
  for (const zone of ["Asia/Singapore", "America/New_York", "UTC"]) {
    const start = dayStart("2026-11-13", zone);
    expect(dayOf(start, zone)).toBe("2026-11-13");
    expect(dayOf(start - 1, zone)).toBe("2026-11-12");
  }
  expect(dayStart("2026-11-13", "Asia/Singapore")).toBe(at("2026-11-12T16:00:00Z"));
  expect(dayOf(at("2026-11-12T16:30:00Z"), "Asia/Singapore")).toBe("2026-11-13");
  expect(refusal(() => dayStart("2026-13-01", "UTC"))).toBe("Give days as YYYY-MM-DD.");
  expect(refusal(() => dayStart("13 Nov", "UTC"))).toBe("Give days as YYYY-MM-DD.");
  expect(refusal(() => dayStart("2026-02-30", "UTC"))).toBe("Give days as YYYY-MM-DD.");
});
