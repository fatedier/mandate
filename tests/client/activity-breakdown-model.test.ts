import { describe, expect, test } from "bun:test";
import { GROUP_OPTIONS, logFilterFor } from "@/routes/activity/breakdown-model";

describe("GROUP_OPTIONS", () => {
  test("offers every dimension the endpoint groups by, model first", () => {
    expect(GROUP_OPTIONS.map((o) => o.id)).toEqual([
      "model", "purpose", "scopeType", "day", "fallback"
    ]);
  });

  test("every option carries a label the reader can read", () => {
    // The ids are wire values; a row of raw ids is what this guards against.
    expect(GROUP_OPTIONS.map((o) => o.label)).toEqual([
      "provider / model", "purpose", "scope type", "day", "fallback"
    ]);
  });
});

describe("logFilterFor", () => {
  test("a model group splits back into the two filters the log takes", () => {
    // The key is one string for display and two filters underneath — sent whole
    // it would match nothing.
    expect(logFilterFor("model", "openai-compatible / codex/gpt-5.6-sol")).toEqual({
      provider: "openai-compatible",
      model: "codex/gpt-5.6-sol"
    });
  });

  test("a model containing a slash keeps it", () => {
    // `codex/gpt-5.6-sol` is a model name with a slash in it, so splitting on
    // every separator would truncate it to `codex`.
    expect(logFilterFor("model", "codex / a/b/c")).toEqual({ provider: "codex", model: "a/b/c" });
  });

  test("the simple dimensions map to one filter each", () => {
    expect(logFilterFor("purpose", "memory_dream")).toEqual({ purpose: "memory_dream" });
    expect(logFilterFor("scopeType", "memory")).toEqual({ scopeType: "memory" });
    expect(logFilterFor("day", "2026-08-04")).toEqual({ day: "2026-08-04" });
    expect(logFilterFor("fallback", "fallback")).toEqual({ fallback: "1" });
    expect(logFilterFor("fallback", "primary")).toEqual({ fallback: "0" });
  });

  test("a group the log cannot express carries no filter at all", () => {
    // "(none)" is a rendering of an empty column, not a value to filter on.
    expect(logFilterFor("scopeType", "(none)")).toBeNull();
    expect(logFilterFor("purpose", "(none)")).toBeNull();
  });
});
