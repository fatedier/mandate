import { expect, test } from "bun:test";
import { parseTmuxLayout } from "../src/client/lib/tmux.js";

test("parseTmuxLayout: returns null for empty/non-string", () => {
  expect(parseTmuxLayout("")).toBe(null);
  expect(parseTmuxLayout(null)).toBe(null);
  expect(parseTmuxLayout(undefined)).toBe(null);
});

test("parseTmuxLayout: parses a single-pane layout", () => {
  const result = parseTmuxLayout("abcd,80x24,0,0,5");
  expect(result).toBeTruthy();
  expect(result.leaves).toEqual([
    { layoutPaneId: "5", x: 0, y: 0, width: 80, height: 24 }
  ]);
});

test("parseTmuxLayout: parses a horizontal split", () => {
  const result = parseTmuxLayout("abcd,80x24,0,0{40x24,0,0,1,40x24,40,0,2}");
  expect(result).toBeTruthy();
  expect(result.leaves.length).toBe(2);
  expect(result.leaves[0]?.layoutPaneId).toBe("1");
  expect(result.leaves[1]?.layoutPaneId).toBe("2");
});
