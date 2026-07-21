import { expect, test } from "bun:test";
import { useSnapshotStore } from "../src/client/store/snapshot.js";

test("snapshot store: initial state", () => {
  const state = useSnapshotStore.getState();
  expect(state.snapshot).toBe(null);
  expect(state.banner).toBe("");
  expect(state.connection).toBe("idle");
});

test("snapshot store: setSnapshot updates and clears banner", () => {
  useSnapshotStore.getState().setBanner("error");
  useSnapshotStore.getState().setSnapshot({ sessions: [] });
  const state = useSnapshotStore.getState();
  expect(state.snapshot).toEqual({ sessions: [] });
  expect(state.banner).toBe("");
});

test("snapshot store: setBanner / clearBanner", () => {
  useSnapshotStore.getState().setBanner("oops");
  expect(useSnapshotStore.getState().banner).toBe("oops");
  useSnapshotStore.getState().clearBanner();
  expect(useSnapshotStore.getState().banner).toBe("");
});

test("snapshot store: setConnection", () => {
  useSnapshotStore.getState().setConnection("open");
  expect(useSnapshotStore.getState().connection).toBe("open");
  useSnapshotStore.getState().setConnection("error");
  expect(useSnapshotStore.getState().connection).toBe("error");
});

import { useUIStore } from "../src/client/store/ui.js";

test("ui store: initial state", () => {
  const state = useUIStore.getState();
  expect(["dark", "light"].includes(state.theme)).toBeTruthy();
  expect(typeof state.sidebarCollapsed).toBe("boolean");
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
