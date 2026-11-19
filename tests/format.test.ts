import { expect, test } from "bun:test";
import {
  compactPath,
  formatCalendarDate,
  formatCalendarDay,
  formatClockMinutes,
  formatClockTime,
  formatDateTime,
  formatDateTimeTitle,
  formatDuration,
  formatDurationAttribute,
  formatElapsedClock,
  formatRelativeTime
} from "../src/client/lib/format.js";

test("compactPath handles common home directory formats", () => {
  expect(compactPath("/Users/alice/projects/mandate")).toBe("~/projects/mandate");
  expect(compactPath("/home/alice/projects/mandate")).toBe("~/projects/mandate");
  expect(compactPath("/var/home/alice/projects/mandate")).toBe("~/projects/mandate");
  expect(compactPath("C:\\Users\\alice\\projects\\mandate")).toBe("~/projects/mandate");
});

test("compactPath: returns input unchanged when no home prefix", () => {
  expect(compactPath("/etc/nginx")).toBe("/etc/nginx");
});

test("compactPath: handles non-string input safely", () => {
  expect(compactPath(null)).toBe("");
  expect(compactPath(undefined)).toBe("");
});

test("chat timestamps use one 24-hour format at every hour", () => {
  expect(formatClockTime("2026-08-02T00:04:05")).toBe("00:04:05");
  // An afternoon instant is the one that moves. Left to the host locale this
  // renders as "06:03:47 PM" under en-US — three characters wider than the
  // morning rows it sits above, and a different string again on a host that is
  // not en-US. Asserting the host's own locale here would only make this test
  // fail on machines set to en-GB, so what is pinned is our output.
  expect(formatClockTime("2026-08-02T18:03:47")).toBe("18:03:47");
  expect(formatClockTime("2026-08-02T18:03:47")).not.toMatch(/[AP]M/);
  expect(formatClockTime("2026-08-02T18:03:47")).toHaveLength(
    formatClockTime("2026-08-02T00:04:05").length
  );
});

// One way to write a date everywhere: month first and spelled —
// never "02/08", which reads as two different days to two readers — with the
// year only when it is not this one. A title always says the year.
const NOW = Date.parse("2026-10-08T12:00:00");

test("a date is month-first and spelled, with the year only when it is not this one", () => {
  expect(formatCalendarDate("2026-08-02T00:04:05", NOW)).toBe("Aug 2");
  expect(formatCalendarDate("2025-08-02T00:04:05", NOW)).toBe("Aug 2, 2025");
  // September is three letters like every other month (en-GB writes "Sept").
  expect(formatCalendarDate("2026-09-27T15:47:00", NOW)).toBe("Sep 27");
});

test("a date with its time, in text, is the date and the minute", () => {
  expect(formatDateTime("2026-09-27T15:47:12", NOW)).toBe("Sep 27 · 15:47");
  expect(formatDateTime("2025-10-08T03:57:12", NOW)).toBe("Oct 8, 2025 · 03:57");
  expect(formatDateTime("nope", NOW)).toBe("");
});

test("a title always says the year, then the clock to the second", () => {
  const timestamp = "2026-08-02T00:04:05";
  expect(formatDateTimeTitle(timestamp)).toBe("Aug 2, 2026, 00:04:05");
  expect(formatDateTimeTitle(timestamp)).toContain(formatClockTime(timestamp));
});

test("a day key is written as a date, on the day it names in any time zone", () => {
  // West of Greenwich an instant at UTC midnight is the evening before, so a
  // key read as an instant would say Sep 6 here.
  const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = "America/Los_Angeles";
  try {
    expect(formatCalendarDay("2026-09-07", NOW)).toBe("Sep 7");
    expect(formatCalendarDay("2025-12-31", NOW)).toBe("Dec 31, 2025");
    expect(formatCalendarDay("2026-13-40", NOW)).toBe("");
    expect(formatCalendarDay("nope", NOW)).toBe("");
  } finally {
    process.env.TZ = zone;
  }
});

test("relative time covers the last week; past it, the date says when", () => {
  const ago = (ms: number) => formatRelativeTime(NOW - ms, NOW);
  const day = 86_400_000;
  expect(ago(30_000)).toBe("just now");
  expect(ago(5 * 60_000)).toBe("5m ago");
  expect(ago(20 * 3_600_000)).toBe("20h ago");
  expect(ago(6 * day)).toBe("6d ago");
  // "105d ago" took arithmetic to place.
  expect(ago(7 * day)).toBe("Oct 1");
  expect(ago(105 * day)).toBe("Jun 25");
  expect(ago(380 * day)).toBe("Sep 23, 2025");
});

// Each band's samples, as [how long ago in ms, what it reads], at its edges.
const relativeBands: { name: string; samples: [number, string][] }[] = [
  { name: "under a minute = just now", samples: [[5_000, "just now"], [29_000, "just now"], [59_000, "just now"]] },
  { name: "1min - 60min = Nm ago", samples: [[60_000, "1m ago"], [3 * 60_000, "3m ago"], [59 * 60_000, "59m ago"]] },
  { name: "1h - 24h = Nh ago", samples: [[60 * 60_000, "1h ago"], [5 * 60 * 60_000, "5h ago"]] },
  { name: "> 24h = Nd ago", samples: [[24 * 60 * 60_000, "1d ago"], [3 * 24 * 60 * 60_000, "3d ago"]] }
];

test.each(relativeBands)("formatRelativeTime: $name", ({ samples }) => {
  const now = 1_000_000_000_000;
  for (const [ago, text] of samples) expect(formatRelativeTime(now - ago, now)).toBe(text);
});

test("formatRelativeTime: missing timestamp → empty string", () => {
  expect(formatRelativeTime(null, Date.now())).toBe("");
  expect(formatRelativeTime(undefined, Date.now())).toBe("");
  expect(formatRelativeTime(0, Date.now())).toBe("");
  expect(formatRelativeTime("not a date", Date.now())).toBe("");
});

test("formatRelativeTime: ISO timestamp", () => {
  expect(formatRelativeTime("2026-04-29T08:00:00.000Z", Date.parse("2026-04-29T08:03:00.000Z"))).toBe("3m ago");
});

test("chat timestamps reject missing and invalid values", () => {
  for (const timestamp of [null, undefined, "", "not-a-date"]) {
    expect(formatClockTime(timestamp)).toBe("");
    expect(formatDateTimeTitle(timestamp)).toBe("");
    expect(formatCalendarDate(timestamp)).toBe("");
    expect(formatRelativeTime(timestamp)).toBe("");
  }
});

test("shared duration formatting keeps seconds for slow multi-minute calls", () => {
  expect(formatDuration(999)).toBe("999ms");
  expect(formatDuration(1_000)).toBe("1.0s");
  expect(formatDuration(312_000)).toBe("5m 12s");
});

test("a duration attribute is a machine duration, not a clock time", () => {
  expect(formatDurationAttribute(312_000)).toBe("PT312S");
  expect(formatDurationAttribute(1_200)).toBe("PT1.2S");
  expect(formatDurationAttribute(1_000)).toBe("PT1S");
  for (const value of [Number.NaN, -1, "nope"]) {
    expect(formatDurationAttribute(value)).toBe("");
  }
});

test("the transcript's divider clock is hours and minutes, 24-hour, at every hour", () => {
  expect(formatClockMinutes("2026-08-02T00:04:05")).toBe("00:04");
  expect(formatClockMinutes("2026-08-02T18:03:47")).toBe("18:03");
  expect(formatClockMinutes("not a time")).toBe("");
});

test("formatElapsedClock: whole seconds under a minute, then as formatDuration writes it", () => {
  expect([0, 999, 1_000, 59_999, 60_000, 65_000, 3_599_000, 3_600_000, -5].map(formatElapsedClock)).toEqual([
    "0s", "0s", "1s", "59s", "1m 00s", "1m 05s", "59m 59s", "1h 00m", "0s"
  ]);
});
