import { expect, test } from "bun:test";
import {
  compactPath,
  formatCalendarDate,
  formatClockTime,
  formatDateTimeTitle,
  formatDuration,
  formatDurationAttribute,
  formatRelativeTime
} from "../src/client/lib/format.js";

test("compactPath: collapses macOS home", () => {
  expect(compactPath("/Users/alice/local/projects/mandate")).toBe("~/local/projects/mandate");
});

test("compactPath: collapses Linux home", () => {
  expect(compactPath("/home/alice/work")).toBe("~/work");
});

test("compactPath: returns input unchanged when no home prefix", () => {
  expect(compactPath("/etc/nginx")).toBe("/etc/nginx");
});

test("compactPath: handles non-string input safely", () => {
  expect(compactPath(null)).toBe("");
  expect(compactPath(undefined)).toBe("");
});

test("formatRelativeTime: under one minute is 'just now'", () => {
  const now = 1_700_000_000_000;
  expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
});

test("formatRelativeTime: minutes", () => {
  const now = 1_700_000_000_000;
  expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
});

test("formatRelativeTime: hours", () => {
  const now = 1_700_000_000_000;
  expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
});

test("formatRelativeTime: days", () => {
  const now = 1_700_000_000_000;
  expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
});

test("formatRelativeTime: empty/invalid input returns empty string", () => {
  expect(formatRelativeTime(null)).toBe("");
  expect(formatRelativeTime(undefined)).toBe("");
  expect(formatRelativeTime(0)).toBe("");
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

test("the calendar date is spelled, and a title reuses that exact date and clock", () => {
  const timestamp = "2026-08-02T00:04:05";
  expect(formatCalendarDate(timestamp)).toBe("02 Aug 2026");
  // Never "02/08/2026": the month has to be unambiguous to a reader who reads
  // dates the other way round.
  expect(formatDateTimeTitle(timestamp)).toBe("02 Aug 2026, 00:04:05");
  expect(formatDateTimeTitle(timestamp)).toContain(formatCalendarDate(timestamp));
  expect(formatDateTimeTitle(timestamp)).toContain(formatClockTime(timestamp));
});

test("chat timestamps reject missing and invalid values", () => {
  for (const timestamp of [null, undefined, "", "not-a-date"]) {
    expect(formatClockTime(timestamp)).toBe("");
    expect(formatDateTimeTitle(timestamp)).toBe("");
    expect(formatCalendarDate(timestamp)).toBe("");
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
