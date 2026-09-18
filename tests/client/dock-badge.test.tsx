import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { badgeValue } from "@/lib/dock-badge";
import { DockBadge } from "@/shell/DockBadge";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import type { Project } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => useProjectsStore.getState().setProjects([]));
  act(() => useWorkItemsStore.setState({ items: new Map() }));
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

function render(set: (count: number | undefined) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<DockBadge set={set} />);
  });
}

test("badgeValue: positive counts pass through, zero and junk clear the badge", () => {
  expect(badgeValue(3)).toBe(3);
  expect(badgeValue(2.7)).toBe(2);
  expect(badgeValue(0)).toBe(undefined);
  expect(badgeValue(-1)).toBe(undefined);
  expect(badgeValue(Number.NaN)).toBe(undefined);
});

test("desktop: sets the badge from the attention count on mount and clears it at zero", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const calls: Array<number | undefined> = [];
  render((c) => { calls.push(c); });
  // No projects or work items in the stores: nothing waits, so the badge is cleared.
  expect(calls).toEqual([undefined]);
  expect(useProjectsStore.getState().projects.length).toBe(0);
  expect(useWorkItemsStore.getState().items.size).toBe(0);
});

test("browser: never touches the badge", () => {
  const calls: Array<number | undefined> = [];
  render((c) => { calls.push(c); });
  expect(calls).toEqual([]);
});

test("desktop: the badge follows the live count — 1 when a feature needs you, cleared when it no longer does", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const calls: Array<number | undefined> = [];
  render((c) => { calls.push(c); });
  const project = { id: "p1", name: "p1", tmuxSessionName: "p1", features: [{ id: "f1", name: "f1", tmuxWindowName: "f1" }] } as unknown as Project;
  act(() => useProjectsStore.getState().setProjects([project]));
  // The store keeps the newer of two versions by updatedAt, so the clearing
  // update must carry a later stamp.
  act(() => useWorkItemsStore.getState().upsert({ id: "wi-f1", featureId: "f1", needsUser: "review", updatedAt: "2026-09-18T10:00:00Z" } as unknown as WorkItemDto));
  expect(calls.at(-1)).toBe(1);
  act(() => useWorkItemsStore.getState().upsert({ id: "wi-f1", featureId: "f1", needsUser: null, updatedAt: "2026-09-18T10:00:01Z" } as unknown as WorkItemDto));
  expect(calls.at(-1)).toBe(undefined);
});
