import { expect, test } from "bun:test";
import { formatAgentTime, localTimeZone } from "../src/server/platform/time/agent-time.js";

test("formatAgentTime: weekday, date, minute and the zone's offset", () => {
  expect(formatAgentTime("2026-10-23T13:45:59.999Z", "Asia/Shanghai")).toBe("Fri 2026-10-23 21:45 +08:00");
  expect(formatAgentTime(Date.parse("2026-10-23T13:45:00Z"), "Asia/Shanghai")).toBe("Fri 2026-10-23 21:45 +08:00");
});

test("formatAgentTime: the local date can be the next day, and midnight is 00", () => {
  expect(formatAgentTime("2026-10-23T16:05:00Z", "Asia/Shanghai")).toBe("Sat 2026-10-24 00:05 +08:00");
});

test("formatAgentTime: UTC and a zone at zero offset read +00:00", () => {
  expect(formatAgentTime("2026-01-05T09:07:00Z", "UTC")).toBe("Mon 2026-01-05 09:07 +00:00");
  expect(formatAgentTime("2026-01-05T09:07:00Z", "Europe/London")).toBe("Mon 2026-01-05 09:07 +00:00");
});

test("formatAgentTime: the offset is the one in force at that instant", () => {
  expect(formatAgentTime("2026-07-01T12:00:00Z", "America/New_York")).toBe("Wed 2026-07-01 08:00 -04:00");
  expect(formatAgentTime("2026-12-01T12:00:00Z", "America/New_York")).toBe("Tue 2026-12-01 07:00 -05:00");
  expect(formatAgentTime("2026-10-23T13:45:00Z", "Asia/Kathmandu")).toBe("Fri 2026-10-23 19:30 +05:45");
});

test("formatAgentTime: a time that does not parse gives null", () => {
  expect(formatAgentTime("not a time", "UTC")).toBeNull();
  expect(formatAgentTime(Number.NaN, "UTC")).toBeNull();
});

test("localTimeZone: the zone the process runs in", () => {
  expect(localTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});
