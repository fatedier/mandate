import { describe, expect, test } from "bun:test";
import { GROUP_OPTIONS, logFilterFor } from "@/routes/activity/breakdown-model";

describe("GROUP_OPTIONS", () => {
  test("offers every dimension the endpoint groups by, model first", () => {
    expect(GROUP_OPTIONS.map((o) => o.id)).toEqual([
      "model", "purpose", "scopeType", "day", "fallback"
    ]);
  });

  test("every option carries a label the reader can read, in sentence case like every other pill", () => {
    // The ids are wire values; a row of raw ids is what this guards against.
    // The section title and the table's first column read the same words:
    // one name per dimension.
    expect(GROUP_OPTIONS.map((o) => o.label)).toEqual([
      "Provider / model", "Purpose", "Scope type", "Day", "Fallback"
    ]);
  });
});

describe("logFilterFor", () => {

  test("a model containing a slash keeps it", () => {
    // `codex/gpt-5.6-sol` is a model name with a slash in it, so splitting on
    // every separator would truncate it to `codex`.
    expect(logFilterFor("model", "codex / a/b/c")).toEqual({ provider: "codex", model: "a/b/c" });
  });

  test("a group the log cannot express carries no filter at all", () => {
    // "(none)" is a rendering of an empty column, not a value to filter on.
    expect(logFilterFor("scopeType", "(none)")).toBeNull();
    expect(logFilterFor("purpose", "(none)")).toBeNull();
  });
});
