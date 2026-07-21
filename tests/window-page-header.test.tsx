import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { WindowPageHeader } from "../src/client/routes/window/WindowPageHeader.js";
import type { SnapshotWindow } from "../src/client/lib/snapshot-types.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

const window = { windowId: "w1", windowName: "sample-task" } as unknown as SnapshotWindow;

const workItem = {
  id: "wi1",
  featureId: "f1",
  title: "Implement the sample feature",
  phase: "working",
  phaseDetail: "Update the worker interface",
  needsUser: null,
  lastActivityAt: new Date().toISOString()
} as unknown as WorkItemDto;

function render(ui: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
}

test("WindowPageHeader: the phase dot breathes while the feature is actually active", () => {
  render(<WindowPageHeader window={window} workItem={workItem} active />);
  const dot = host!.querySelector(".bg-phase-working");
  expect(dot).toBeTruthy();
  expect(dot!.className).toContain("animate-live");
});

test("WindowPageHeader: the phase dot is still without live activity", () => {
  render(<WindowPageHeader window={window} workItem={workItem} active={false} />);
  const dot = host!.querySelector(".bg-phase-working");
  expect(dot).toBeTruthy();
  expect(dot!.className).not.toContain("animate-live");
});
