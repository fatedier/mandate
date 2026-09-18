import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FeatureTitle } from "@/routes/window/WindowPageHeader";
import type { SnapshotWindow } from "@/lib/snapshot-types";
import type { WorkItemDto } from "@shared/api/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

const window = { windowId: "w1", windowName: "sample-task" } as unknown as SnapshotWindow;

function item(over: Partial<WorkItemDto>): WorkItemDto {
  return { id: "wi1", featureId: "f1", phase: "working", needsUser: null, ...over } as unknown as WorkItemDto;
}

function render(ui: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
}

test("FeatureTitle: the human title leads and is the only truncating element", () => {
  render(<FeatureTitle window={window} workItem={item({ title: "Implement the sample feature" })} />);
  const h1 = host!.querySelector<HTMLElement>('h1[data-slot="feature-title"]');
  expect(h1 === null).toBe(false);
  expect(h1!.textContent).toBe("Implement the sample feature");
  for (const token of ["min-w-0", "flex-1", "truncate"]) expect(h1!.className.split(/\s+/)).toContain(token);
});

test("FeatureTitle: falls back to the tmux window name when there is no human title", () => {
  render(<FeatureTitle window={window} workItem={item({ title: "" })} />);
  expect(host!.querySelector('h1[data-slot="feature-title"]')!.textContent).toContain("sample-task");
});

test("FeatureTitle: exactly one pill, and attention wins over phase", () => {
  render(<FeatureTitle window={window} workItem={item({ phase: "done", needsUser: "review" })} />);
  const pills = host!.querySelectorAll('[data-slot="feature-status"]');
  expect(pills.length).toBe(1);
  const pill = pills[0] as HTMLElement;
  expect(pill.textContent).toBe("Needs review");
  const tokens = pill.className.split(/\s+/);
  expect(tokens).toContain("pill");
  expect(tokens).toContain("pill-review");
  expect(tokens).not.toContain("pill-green");
});

// Signal grammar: motion means real activity (agent wake or pane working).
// The motion lives on a dot inside the pill, never on the text.
const LIVE = '[data-slot="feature-status"] [data-slot="feature-live"]';

test("FeatureTitle: the pill carries a breathing dot while the feature is actually active", () => {
  render(<FeatureTitle window={window} workItem={item({ phase: "working" })} active />);
  const dot = host!.querySelector<HTMLElement>(LIVE);
  expect(dot === null).toBe(false);
  expect(dot!.className.split(/\s+/)).toContain("animate-live");
  expect(dot!.getAttribute("aria-hidden")).not.toBe(null);
  expect(host!.querySelector('[data-slot="feature-status"]')!.textContent).toBe("Working");
});

test("FeatureTitle: no dot without live activity, whether active is false or omitted", () => {
  render(<FeatureTitle window={window} workItem={item({ phase: "working" })} active={false} />);
  expect(host!.querySelector(LIVE) === null).toBe(true);
  act(() => root!.unmount());
  host!.remove();
  render(<FeatureTitle window={window} workItem={item({ phase: "working" })} />);
  expect(host!.querySelector(LIVE) === null).toBe(true);
});

test("FeatureTitle: motion never lands on the title text", () => {
  render(<FeatureTitle window={window} workItem={item({ phase: "working", title: "Alpha" })} active />);
  const h1 = host!.querySelector<HTMLElement>('h1[data-slot="feature-title"]')!;
  expect(h1.className.split(/\s+/)).not.toContain("animate-live");
  expect(h1.querySelector('[data-slot="feature-live"]') === null).toBe(true);
});

test("FeatureTitle: no work item renders the title and no pill", () => {
  render(<FeatureTitle window={window} workItem={null} />);
  expect(host!.querySelector('h1[data-slot="feature-title"]') === null).toBe(false);
  expect(host!.querySelector('[data-slot="feature-status"]') === null).toBe(true);
});
