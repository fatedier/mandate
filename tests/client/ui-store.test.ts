import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RECENT_PANES_MAX, pushRecentPane, useUIStore, type RecentPane } from "@/store/ui";

describe("interface zoom", () => {
  afterEach(() => {
    useUIStore.setState({ interfaceZoom: 1 });
    localStorage.removeItem("mandate.ui");
  });

  test("interfaceZoom defaults to 100% and setInterfaceZoom snaps to the ladder", () => {
    expect(useUIStore.getState().interfaceZoom).toBe(1);
    useUIStore.getState().setInterfaceZoom(1.25);
    expect(useUIStore.getState().interfaceZoom).toBe(1.25);
    useUIStore.getState().setInterfaceZoom(1.3);
    expect(useUIStore.getState().interfaceZoom).toBe(1.25);
    useUIStore.getState().setInterfaceZoom(Number.NaN);
    expect(useUIStore.getState().interfaceZoom).toBe(1);
  });

  test("interfaceZoom persists under mandate.ui", () => {
    useUIStore.getState().setInterfaceZoom(1.5);
    const saved = JSON.parse(localStorage.getItem("mandate.ui") ?? "{}");
    expect(saved.state.interfaceZoom).toBe(1.5);
  });

  test("rehydration snaps a persisted off-ladder value and ignores a non-number", async () => {
    // Rehydrate merges into the live state, so a non-number keeps whatever the
    // store holds (the default here), rather than becoming NaN.
    for (const [persisted, expected] of [[1.2, 1.25], ["big", 1], [null, 1], [0.05, 0.8]] as const) {
      useUIStore.setState({ interfaceZoom: 1 });
      localStorage.setItem("mandate.ui", JSON.stringify({ state: { interfaceZoom: persisted }, version: 0 }));
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().interfaceZoom).toBe(expected);
    }
  });
});

describe("recent panes", () => {
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
    const saved = JSON.parse(localStorage.getItem("mandate.ui") ?? "{}");
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

  test("rememberPane stamps `at` and persists under mandate.ui", () => {
    useUIStore.getState().rememberPane({ sessionName: "s", windowName: "w", paneId: "%9" }, "2026-09-17T12:00:00Z");
    expect(useUIStore.getState().recentPanes[0]).toEqual(e("%9", "2026-09-17T12:00:00Z"));
    const saved = JSON.parse(localStorage.getItem("mandate.ui") ?? "{}");
    expect(saved.state.recentPanes[0].paneId).toBe("%9");
  });

  test("rehydration drops persisted entries that are not pane records", async () => {
    const valid: RecentPane = { paneId: "%1", sessionName: "s", windowName: "w", at: "2026-09-17T00:00:00Z" };
    localStorage.setItem("mandate.ui", JSON.stringify({ state: { recentPanes: [null, valid, "x"] }, version: 0 }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().recentPanes).toEqual([valid]);
  });
});

describe("the worker panel's ratio", () => {
  test("the panel's ratio survives hydration; a missing or broken one is the equal split", () => {
    const current = useUIStore.getState();
    const { merge, partialize } = useUIStore.persist.getOptions();
    expect(merge!({ workerPanelRatio: 0.6 }, current).workerPanelRatio).toBe(0.6);
    expect(merge!({ workerPanelRatio: "wide" }, current).workerPanelRatio).toBe(0.5);
    expect(merge!(undefined, current).workerPanelRatio).toBe(0.5);
    expect(partialize!({ ...current, workerPanelRatio: 0.7 })).toMatchObject({ workerPanelRatio: 0.7 });
    // The retired dock's ratio is not carried over.
    expect(partialize!(merge!({ chatPanelRatio: 0.3 }, current))).not.toHaveProperty("chatPanelRatio");
  });
});
