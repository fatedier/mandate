import { beforeEach, expect, test } from "bun:test";
import { RECENT_PANES_MAX, pushRecentPane, useUIStore, type RecentPane } from "@/store/ui";

const e = (paneId: string, at: string): RecentPane => ({ sessionName: "s", windowName: "w", paneId, at });

beforeEach(() => { useUIStore.setState({ recentPanes: [] }); });

test("forgetPane drops one entry by paneId and clearRecentPanes empties the list", () => {
  useUIStore.setState({ recentPanes: [e("%1", "2026-09-17T10:00:00Z"), e("%2", "2026-09-17T09:00:00Z")] });
  useUIStore.getState().forgetPane("%1");
  expect(useUIStore.getState().recentPanes.map((x) => x.paneId)).toEqual(["%2"]);
  useUIStore.getState().forgetPane("%nope");
  expect(useUIStore.getState().recentPanes.length).toBe(1);
  useUIStore.getState().clearRecentPanes();
  expect(useUIStore.getState().recentPanes).toEqual([]);
  const saved = JSON.parse(localStorage.getItem("ap.ui") ?? "{}");
  expect(saved.state.recentPanes).toEqual([]);
});

test("pushRecentPane puts the entry first and dedupes by paneId", () => {
  const list = pushRecentPane([e("%1", "2026-09-17T10:00:00Z"), e("%2", "2026-09-17T09:00:00Z")], e("%2", "2026-09-17T11:00:00Z"));
  expect(list.map((x) => x.paneId)).toEqual(["%2", "%1"]);
  expect(list[0]!.at).toBe("2026-09-17T11:00:00Z");
});

test("pushRecentPane caps the list", () => {
  let list: RecentPane[] = [];
  for (let i = 0; i < RECENT_PANES_MAX + 5; i += 1) list = pushRecentPane(list, e(`%${i}`, `2026-09-17T10:${String(i).padStart(2, "0")}:00Z`));
  expect(list.length).toBe(RECENT_PANES_MAX);
  expect(list[0]!.paneId).toBe(`%${RECENT_PANES_MAX + 4}`);
});

test("rememberPane stamps `at` and persists under ap.ui", () => {
  useUIStore.getState().rememberPane({ sessionName: "s", windowName: "w", paneId: "%9" }, "2026-09-17T12:00:00Z");
  expect(useUIStore.getState().recentPanes[0]).toEqual(e("%9", "2026-09-17T12:00:00Z"));
  const saved = JSON.parse(localStorage.getItem("ap.ui") ?? "{}");
  expect(saved.state.recentPanes[0].paneId).toBe("%9");
});

test("rehydration drops persisted entries that are not pane records", async () => {
  const valid: RecentPane = { paneId: "%1", sessionName: "s", windowName: "w", at: "2026-09-17T00:00:00Z" };
  localStorage.setItem("ap.ui", JSON.stringify({ state: { recentPanes: [null, valid, "x"] }, version: 0 }));
  await useUIStore.persist.rehydrate();
  expect(useUIStore.getState().recentPanes).toEqual([valid]);
});
