import { expect, test } from "bun:test";
import {
  PANE_CURSOR_MAX_ENTRIES,
  PaneReadCursorStore
} from "../src/server/modules/panes/pane-read-cursor.js";

test("PaneReadCursorStore: remembers the line set per thread+pane", () => {
  const store = new PaneReadCursorStore();
  expect(store.get("t1", "%1")).toBeNull();
  store.remember("t1", "%1", "a\nb", true);
  expect([...store.get("t1", "%1")!.lines]).toEqual(["a", "b"]);
  expect(store.get("t1", "%2")).toBeNull();
  expect(store.get("t2", "%1")).toBeNull();
});

test("PaneReadCursorStore: a later read replaces the remembered lines instead of accumulating", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "a\nb", true);
  store.remember("t1", "%1", "c", true);
  expect([...store.get("t1", "%1")!.lines]).toEqual(["c"]);
});

test("PaneReadCursorStore: an all-blank capture is remembered as an empty line set", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "\n   \n", true);
  const entry = store.get("t1", "%1");
  expect(entry).not.toBeNull();
  expect(entry!.lines.size).toBe(0);
});

test("PaneReadCursorStore: zeroNewStreak counts consecutive idle reads and resets on new output", () => {
  const store = new PaneReadCursorStore();
  expect(store.remember("t1", "%1", "a", true)).toBe(0);
  expect(store.remember("t1", "%1", "a", false)).toBe(1);
  expect(store.remember("t1", "%1", "a", false)).toBe(2);
  expect(store.remember("t1", "%1", "a\nb", true)).toBe(0);
});

test("PaneReadCursorStore: the stored entry carries the same streak remember returned", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "a", true);
  store.remember("t1", "%1", "a", false);
  store.remember("t1", "%1", "a", false);
  expect(store.get("t1", "%1")!.zeroNewStreak).toBe(2);
});

test("PaneReadCursorStore: each pane keeps its own streak", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "a", false);
  store.remember("t1", "%1", "a", false);
  expect(store.remember("t1", "%2", "a", false)).toBe(1);
  expect(store.get("t1", "%1")!.zeroNewStreak).toBe(2);
});

test("PaneReadCursorStore: forget drops one pane and restarts its streak", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "a", false);
  store.remember("t1", "%2", "a", false);
  store.forget("t1", "%1");
  expect(store.get("t1", "%1")).toBeNull();
  expect(store.get("t1", "%2")!.zeroNewStreak).toBe(1);
  expect(store.remember("t1", "%1", "a", false)).toBe(1);
});

test("PaneReadCursorStore: forget is a no-op for a pane with no cursor", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "a", true);
  store.forget("t1", "%2");
  expect(store.get("t1", "%1")).not.toBeNull();
});

test("PaneReadCursorStore: resetThread clears only that thread", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "a", true);
  store.remember("t1", "%2", "a", true);
  store.remember("t2", "%1", "a", true);
  store.resetThread("t1");
  expect(store.get("t1", "%1")).toBeNull();
  expect(store.get("t1", "%2")).toBeNull();
  expect(store.get("t2", "%1")).not.toBeNull();
});

test("PaneReadCursorStore: resetThread does not clear a thread whose id merely starts the same", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "a", true);
  store.remember("t10", "%1", "a", true);
  store.resetThread("t1");
  expect(store.get("t1", "%1")).toBeNull();
  expect(store.get("t10", "%1")).not.toBeNull();
});

test("PaneReadCursorStore: a reset thread starts its streak over", () => {
  const store = new PaneReadCursorStore();
  store.remember("t1", "%1", "a", false);
  store.remember("t1", "%1", "a", false);
  store.resetThread("t1");
  expect(store.remember("t1", "%1", "a", false)).toBe(1);
});

test("PaneReadCursorStore: evicts least-recently-used entries past the cap", () => {
  const store = new PaneReadCursorStore();
  for (let i = 0; i < PANE_CURSOR_MAX_ENTRIES; i++) store.remember("t", `%${i}`, "x", true);
  store.get("t", "%0"); // touch the oldest so it survives
  store.remember("t", "%new", "x", true); // pushes size over the cap
  expect(store.get("t", "%0")).not.toBeNull();
  expect(store.get("t", "%1")).toBeNull();
  expect(store.get("t", "%new")).not.toBeNull();
});

test("PaneReadCursorStore: re-reading an existing pane does not evict anything", () => {
  const store = new PaneReadCursorStore();
  for (let i = 0; i < PANE_CURSOR_MAX_ENTRIES; i++) store.remember("t", `%${i}`, "x", true);
  store.remember("t", "%0", "x", true);
  expect(store.get("t", "%1")).not.toBeNull();
  expect(store.get("t", `%${PANE_CURSOR_MAX_ENTRIES - 1}`)).not.toBeNull();
});
