import { expect, test } from "bun:test";
import {
  formatLogError,
  logError,
  parseLogLevel,
  setLogLevel
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

test("logError suppresses stacks for known operational errors at every level", () => {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  const oldDebug = process.env.MANDATE_DEBUG;
  const oldStacks = process.env.MANDATE_LOG_STACKS;
  process.env.MANDATE_LOG_LEVEL = "debug";
  delete process.env.MANDATE_DEBUG;
  process.env.MANDATE_LOG_STACKS = "1";
  try {
    logError("test", new Error("The operation timed out."), "failed");
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("[mandate] test: The operation timed out.");

    logError("test", new Error("boom"), "failed");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[lines.length - 1] ?? "").toContain("Error: boom");
  } finally {
    console.error = originalError;
    setLogLevel("info");
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
    if (oldDebug === undefined) delete process.env.MANDATE_DEBUG;
    else process.env.MANDATE_DEBUG = oldDebug;
    if (oldStacks === undefined) delete process.env.MANDATE_LOG_STACKS;
    else process.env.MANDATE_LOG_STACKS = oldStacks;
  }
});
