import { expect, test } from "bun:test";
import { getChatPanelWidth } from "../../src/client/lib/pane-layout";
import { useUIStore } from "../../src/client/store/ui";

test("equal split works beyond the old chat width limit", () => {
  expect(getChatPanelWidth(1872, 0.5)).toBe(936);
  expect(getChatPanelWidth(1392, 0.5)).toBe(696);
});

test("both panes stay usable when the viewport or sidebar changes", () => {
  expect(getChatPanelWidth(1000, 0.95)).toBe(680);
  expect(getChatPanelWidth(1000, 0.05)).toBe(320);
  expect(getChatPanelWidth(548, 0.8)).toBe(274);
});

test("saved ratios survive hydration and missing ratios use an equal split", () => {
  const current = { ...useUIStore.getState(), chatPanelRatio: 0.5 };
  const { merge, partialize } = useUIStore.persist.getOptions();
  const restored = merge!({ chatPanelWidth: 650, sidebarCollapsed: true }, current);
  expect(restored.chatPanelRatio).toBe(0.5);
  expect(restored.sidebarCollapsed).toBe(true);
  expect(getChatPanelWidth(1392, restored.chatPanelRatio)).toBe(696);
  expect(merge!({ chatPanelRatio: null }, current).chatPanelRatio).toBe(0.5);
  expect(merge!({ chatPanelRatio: 0.6 }, current).chatPanelRatio).toBe(0.6);
  expect(merge!(undefined, current).chatPanelRatio).toBe(0.5);
  expect(partialize!(restored)).not.toHaveProperty("chatPanelWidth");
});
