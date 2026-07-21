import { describe, expect, test } from "bun:test";
import { unwrapErrorReason } from "../src/shared/error-reason.js";

/**
 * Wrapped provider failures record "Type validation failed" because the
 * provider returned its error object down the streaming channel and the SDK
 * matched it against the delta schema. The reason a reader needs is inside.
 */
describe("unwrapErrorReason", () => {
  test("takes the provider's message out of a validation wrapper", () => {
    const raw =
      'Type validation failed: Value: {"error":{"message":"litellm.APIError: ' +
      'Our servers are currently overloaded. Please try again later.","type":null,' +
      '"param":null,"code":"500"}}.\nError message: [\n  {\n    "code": "invalid_union"';
    expect(unwrapErrorReason(raw)).toBe(
      "Our servers are currently overloaded. Please try again later. (500)"
    );
  });

  test("keeps a URL intact", () => {
    // Splitting on ":" to strip the SDK prefix cuts https:// in half and yields
    // "//chatgpt.com/cyber". Only a known prefix may be removed.
    const raw =
      'Type validation failed: Value: {"error":{"message":"litellm.APIError: This content ' +
      'was flagged. Join the Trusted Access program: https://chatgpt.com/cyber","code":"500"}}.';
    const reason = unwrapErrorReason(raw);
    expect(reason).toContain("https://chatgpt.com/cyber");
    expect(reason.startsWith("//chatgpt.com/cyber")).toBe(false);
    expect(reason.startsWith("This content was flagged")).toBe(true);
  });

  test("an unwrapped error keeps its own first line", () => {
    expect(unwrapErrorReason("Service Unavailable")).toBe("Service Unavailable");
    expect(
      unwrapErrorReason("TimeoutError: LLM stream timed out waiting for activity\n  at foo")
    ).toBe("TimeoutError: LLM stream timed out waiting for activity");
  });

  test("unparseable nesting falls back rather than throwing", () => {
    // A truncated payload is the normal case for a long Zod dump.
    expect(unwrapErrorReason('Type validation failed: Value: {"error":{"mess')).toBe(
      'Type validation failed: Value: {"error":{"mess'
    );
  });

  test("blank input never yields a blank label", () => {
    expect(unwrapErrorReason(null)).toBe("(no message)");
    expect(unwrapErrorReason("   ")).toBe("(no message)");
  });

  test("is bounded, so one reason cannot fill the panel", () => {
    expect(unwrapErrorReason("x".repeat(400)).length).toBeLessThanOrEqual(120);
  });

  test("a hostile code cannot break the bound or crowd out the message", () => {
    // `code` is provider-controlled, so the suffix needs a bound of its own.
    // Budgeting the message against an unbounded suffix drove the remaining
    // width negative, sliced the message away to "", and returned ~304
    // characters that were entirely code.
    const raw = JSON.stringify({
      error: {
        message: `litellm.APIError: ${"the upstream pool is saturated. ".repeat(10)}`,
        code: "9".repeat(300)
      }
    });
    const reason = unwrapErrorReason(raw);
    expect(reason.length).toBeLessThanOrEqual(120);
    expect(reason).toContain("the upstream pool is saturated");
  });
});
