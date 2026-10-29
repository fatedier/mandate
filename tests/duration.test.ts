import { expect, test } from "bun:test";
import { formatDurationShort, parseDurationMs } from "../src/server/modules/agent/duration.js";

test("durations parse the units the alarm tool has always accepted", () => {
  expect(parseDurationMs("30s")).toBe(30_000);
  expect(parseDurationMs("5m")).toBe(300_000);
  expect(parseDurationMs("2h")).toBe(7_200_000);
  expect(parseDurationMs("1d")).toBe(86_400_000);
  expect(parseDurationMs("1.5h")).toBe(5_400_000);
  expect(parseDurationMs("90 minutes")).toBe(5_400_000);
  expect(parseDurationMs("soon")).toBe(null);
  expect(parseDurationMs("")).toBe(null);
});

test("a duration formats back to its largest whole unit", () => {
  expect(formatDurationShort(30_000)).toBe("30s");
  expect(formatDurationShort(300_000)).toBe("5m");
  expect(formatDurationShort(7_200_000)).toBe("2h");
  expect(formatDurationShort(86_400_000)).toBe("1d");
  expect(formatDurationShort(90_000)).toBe("90s");
  expect(formatDurationShort(5_400_000)).toBe("90m");
});
