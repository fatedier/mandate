import { afterEach, expect, test } from "bun:test";
import { useUIStore } from "@/store/ui";

afterEach(() => {
  useUIStore.setState({ interfaceZoom: 1 });
  localStorage.removeItem("ap.ui");
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

test("interfaceZoom persists under ap.ui", () => {
  useUIStore.getState().setInterfaceZoom(1.5);
  const saved = JSON.parse(localStorage.getItem("ap.ui") ?? "{}");
  expect(saved.state.interfaceZoom).toBe(1.5);
});

test("rehydration snaps a persisted off-ladder value and ignores a non-number", async () => {
  // Rehydrate merges into the live state, so a non-number keeps whatever the
  // store holds (the default here), rather than becoming NaN.
  for (const [persisted, expected] of [[1.2, 1.25], ["big", 1], [null, 1], [0.05, 0.8]] as const) {
    useUIStore.setState({ interfaceZoom: 1 });
    localStorage.setItem("ap.ui", JSON.stringify({ state: { interfaceZoom: persisted }, version: 0 }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().interfaceZoom).toBe(expected);
  }
});
