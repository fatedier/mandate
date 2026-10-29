import { expect, test } from "bun:test";
import { formatWindowTitle } from "../src/client/lib/window-format.js";

const titles: { name: string; window: Parameters<typeof formatWindowTitle>[0]; title: string }[] = [
  { name: "index + name", window: { windowIndex: 2, windowName: "work-1" }, title: "2: work-1" },
  { name: "index only when name missing", window: { windowIndex: 0, windowName: "" }, title: "window 0" },
  { name: "empty when fully missing", window: {}, title: "(unknown window)" }
];

test.each(titles)("formatWindowTitle: $name", ({ window, title }) => {
  expect(formatWindowTitle(window)).toBe(title);
});
