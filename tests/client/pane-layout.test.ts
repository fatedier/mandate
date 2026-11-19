import { expect, test } from "bun:test";
import { getSidePanelWidth } from "../../src/client/lib/pane-layout";

test("equal split works beyond the old 900px limit", () => {
  expect(getSidePanelWidth(1872, 0.5)).toBe(936);
  expect(getSidePanelWidth(1392, 0.5)).toBe(696);
});

test("both panes stay usable when the viewport or sidebar changes", () => {
  expect(getSidePanelWidth(1000, 0.95)).toBe(680);
  expect(getSidePanelWidth(1000, 0.05)).toBe(320);
  expect(getSidePanelWidth(548, 0.8)).toBe(274);
});
