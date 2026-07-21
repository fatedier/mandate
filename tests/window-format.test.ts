import { expect, test } from "bun:test";
import { formatWindowTitle } from "../src/client/lib/window-format.js";

test("formatWindowTitle: index + name", () => {
  expect(formatWindowTitle({ windowIndex: 2, windowName: "work-1" })).toBe("2: work-1");
});

test("formatWindowTitle: index only when name missing", () => {
  expect(formatWindowTitle({ windowIndex: 0, windowName: "" })).toBe("window 0");
});

test("formatWindowTitle: empty when fully missing", () => {
  expect(formatWindowTitle({})).toBe("(unknown window)");
});
