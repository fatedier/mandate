import { expect, test } from "bun:test";
import { useSnapshotStore } from "../src/client/store/snapshot.js";
import { useUIStore } from "../src/client/store/ui.js";

// The state the store is made with, not what an earlier test in this
// process left in it.
test("snapshot store: initial state", () => {
  const state = useSnapshotStore.getInitialState();
  expect(state.snapshot).toBe(null);
  expect(state.banner).toBe("");
  expect(state.connection).toBe("idle");
});

test("ui store: setTheme updates theme", () => {
  useUIStore.getState().setTheme("light");
  expect(useUIStore.getState().theme).toBe("light");
  useUIStore.getState().setTheme("dark");
  expect(useUIStore.getState().theme).toBe("dark");
});

test("ui store: setSidebarCollapsed updates flag", () => {
  useUIStore.getState().setSidebarCollapsed(true);
  expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  useUIStore.getState().setSidebarCollapsed(false);
  expect(useUIStore.getState().sidebarCollapsed).toBe(false);
});
