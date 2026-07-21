import { describe, expect, test } from "bun:test";
import { buildSplitRows, parseUnifiedDiff, type DiffLine } from "@/lib/diff-parse";

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 5626abf..f719efd 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,3 @@",
  " one",
  "-two",
  "+two!",
  "+three",
  "\\ No newline at end of file"
].join("\n");

describe("parseUnifiedDiff", () => {
  test("splits hunks and numbers lines", () => {
    const hunks = parseUnifiedDiff(PATCH);
    expect(hunks.length).toBe(1);
    const h = hunks[0]!;
    expect(h.header).toBe("@@ -1,2 +1,3 @@");
    expect(h.lines.map((l) => l.kind)).toEqual(["context", "del", "add", "add"]);
    expect(h.lines[0]).toEqual({ kind: "context", text: "one", oldNo: 1, newNo: 1 });
    expect(h.lines[1]).toEqual({ kind: "del", text: "two", oldNo: 2, newNo: null });
    expect(h.lines[2]).toEqual({ kind: "add", text: "two!", oldNo: null, newNo: 2 });
    expect(h.lines[3]).toEqual({ kind: "add", text: "three", oldNo: null, newNo: 3 });
  });

  test("empty and binary patches produce no hunks", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("Binary files /dev/null and b/x.png differ\n")).toEqual([]);
  });
});

describe("buildSplitRows", () => {
  test("pairs del runs with add runs and fills leftovers", () => {
    const lines = parseUnifiedDiff(PATCH)[0]!.lines;
    const rows = buildSplitRows(lines);
    expect(rows).toEqual([
      { left: lines[0]!, right: lines[0]! },
      { left: lines[1]!, right: lines[2]! },
      { left: null, right: lines[3]! }
    ]);
  });

  test("del-only run leaves the right side empty", () => {
    const del: DiffLine = { kind: "del", text: "gone", oldNo: 5, newNo: null };
    expect(buildSplitRows([del])).toEqual([{ left: del, right: null }]);
  });

  test("context after a change run starts a new pairing group", () => {
    const lines: DiffLine[] = [
      { kind: "del", text: "a", oldNo: 1, newNo: null },
      { kind: "context", text: "c", oldNo: 2, newNo: 1 },
      { kind: "add", text: "b", oldNo: null, newNo: 2 }
    ];
    expect(buildSplitRows(lines)).toEqual([
      { left: lines[0]!, right: null },
      { left: lines[1]!, right: lines[1]! },
      { left: null, right: lines[2]! }
    ]);
  });
});
