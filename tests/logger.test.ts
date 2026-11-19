import { expect, test } from "bun:test";
import {
  formatLogError,
  logError,
  parseLogLevel,
  setLogLevel,
  setLogStacks
} from "../src/server/platform/logger.js";

test("formatLogError keeps provider errors compact", () => {
  const message = formatLogError({
    type: "error",
    sequence_number: 2,
    error: {
      type: "service_unavailable_error",
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded.\nPlease try again later.",
      param: null
    }
  });

  expect(message).toBe("Our servers are currently overloaded. Please try again later. (server_is_overloaded)");
  expect(message).not.toContain("\n");
  expect(message).not.toContain("[object Object]");
});

test("formatLogError truncates noisy error strings", () => {
  const message = formatLogError("x".repeat(1300));
  expect(message.length).toBeLessThan(1300);
  expect(message).toContain("truncated");
});

test("parseLogLevel accepts supported levels only", () => {
  expect(parseLogLevel("debug")).toBe("debug");
  expect(parseLogLevel("WARN")).toBe("warn");
  expect(parseLogLevel("verbose")).toBe(null);
});

test("with stacks on at debug, logError prints a stack, never for known operational errors", () => {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  setLogLevel("debug");
  setLogStacks(true);
  try {
    logError("test", new Error("The operation timed out."));
    expect(lines).toEqual(["[mandate] test: The operation timed out."]);

    logError("test", new Error("boom"));
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[lines.length - 1] ?? "").toContain("Error: boom");

    lines.length = 0;
    setLogStacks(false);
    logError("test", new Error("boom"));
    expect(lines).toEqual(["[mandate] test: boom"]);
  } finally {
    console.error = originalError;
    setLogLevel("info");
    setLogStacks(false);
  }
});

// What was being done (a path, a thread) is in the line with the error's own
// words: as a fallback the error replaced, it was lost whenever the error
// said something, which is nearly always.
test("logError's context comes before the error's words; an error with none is told by the context alone", () => {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  setLogLevel("error");
  try {
    logError("thread delete", new Error("EACCES: permission denied"), "could not remove /data/resources/threads/thr_1");
    logError("idle compaction", new Error(""), "firing thr_1");
    logError("cache seal", new Error("boom"));
    logError("price data", null);
    expect(lines).toEqual([
      "[mandate] thread delete: could not remove /data/resources/threads/thr_1: EACCES: permission denied",
      "[mandate] idle compaction: firing thr_1",
      "[mandate] cache seal: boom",
      "[mandate] price data: operation failed"
    ]);
  } finally {
    console.error = originalError;
    setLogLevel("info");
  }
});

test("the environment sets neither the level nor stacks", () => {
  const keys = ["MANDATE_LOG_LEVEL", "MANDATE_DEBUG", "MANDATE_LOG_STACKS"] as const;
  const before = keys.map((key) => process.env[key]);
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  process.env.MANDATE_LOG_LEVEL = "silent";
  process.env.MANDATE_DEBUG = "1";
  process.env.MANDATE_LOG_STACKS = "1";
  setLogLevel("error");
  try {
    logError("test", new Error("boom"));
    expect(lines).toEqual(["[mandate] test: boom"]);
  } finally {
    console.error = originalError;
    setLogLevel("info");
    keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
  }
});
