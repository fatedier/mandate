import { afterEach, expect, test } from "bun:test";
import { FeatureTitle } from "@/routes/window/WindowPageHeader";
import type { SnapshotWindow } from "@/lib/snapshot-types";
import type { WorkItemDto } from "@shared/api/work-items";
import { emptyPlan, type PlanStepStatus } from "@shared/api/plans";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, type Mounted } from "../helpers/mount.js";

let host: HTMLElement | null = null;
let view: Mounted | null = null;

afterEach(() => {
  // Unmount before the plans store the title reads is reset under it.
  runCleanups();
  useFeaturePlansStore.setState({ plans: new Map() });
  host = null;
  view = null;
});

const window = { windowId: "w1", windowName: "sample-task" } as unknown as SnapshotWindow;

function item(over: Partial<WorkItemDto>): WorkItemDto {
  return { id: "wi1", featureId: "f1", phase: "working", ...over } as unknown as WorkItemDto;
}

/** The feature's plan, as the store would hold it after a fetch or a push. */
function planOf(...statuses: PlanStepStatus[]) {
  useFeaturePlansStore.setState({ plans: new Map([["f1", {
    ...emptyPlan("f1"),
    steps: statuses.map((status, i) => ({
      id: i + 1, title: `s${i + 1}`, status, note: "n", createdAt: "2026-09-14T12:00:00.000Z",
      startedAt: null, blockedAt: null, completedAt: null, updatedAt: "2026-09-14T12:00:00.000Z"
    })),
    updatedAt: "2026-09-14T12:00:00.000Z"
  }]]) });
}

function render(ui: React.ReactNode) {
  view = mount(ui);
  host = view.host;
}

test("FeatureTitle: the human title leads and is the only truncating element", () => {
  render(<FeatureTitle featureId="f1" window={window} workItem={item({ title: "Implement the sample feature" })} />);
  const h1 = host!.querySelector<HTMLElement>('h1[data-slot="feature-title"]');
  expect(h1 === null).toBe(false);
  expect(h1!.textContent).toBe("Implement the sample feature");
  for (const token of ["min-w-0", "flex-1", "truncate"]) expect(h1!.className.split(/\s+/)).toContain(token);
});

test("FeatureTitle: falls back to the tmux window name when there is no human title", () => {
  render(<FeatureTitle featureId="f1" window={window} workItem={item({ title: "" })} />);
  expect(host!.querySelector('h1[data-slot="feature-title"]')!.textContent).toContain("sample-task");
});

test("FeatureTitle: exactly one pill, and a failure wins over the plan", () => {
  planOf("done");
  render(<FeatureTitle featureId="f1" window={window} workItem={item({ failedAt: "2026-10-09T03:59:00.000Z", failedMessage: "boom", failedKind: "error" })} />);
  const pills = host!.querySelectorAll('[data-slot="feature-status"]');
  expect(pills.length).toBe(1);
  const pill = pills[0] as HTMLElement;
  expect(pill.textContent).toBe("Failed");
  const tokens = pill.className.split(/\s+/);
  expect(tokens).toContain("pill");
  expect(tokens).toContain("pill-red");
  expect(tokens).not.toContain("pill-green");
});

// Signal grammar: motion means real activity (agent wake or pane working).
// The motion lives on a dot inside the pill, never on the text.
const LIVE = '[data-slot="feature-status"] [data-slot="feature-live"]';

test("FeatureTitle: the pill carries a breathing dot while the feature is actually active", () => {
  planOf("done", "in_progress");
  render(<FeatureTitle featureId="f1" window={window} workItem={item({})} active />);
  const dot = host!.querySelector<HTMLElement>(LIVE);
  expect(dot === null).toBe(false);
  expect(dot!.className.split(/\s+/)).toContain("animate-live");
  expect(dot!.getAttribute("aria-hidden")).not.toBe(null);
  expect(host!.querySelector('[data-slot="feature-status"]')!.textContent).toBe("In progress");
});

test("FeatureTitle: no dot without live activity, whether active is false or omitted", () => {
  render(<FeatureTitle featureId="f1" window={window} workItem={item({})} active={false} />);
  expect(host!.querySelector(LIVE) === null).toBe(true);
  view!.unmount();
  render(<FeatureTitle featureId="f1" window={window} workItem={item({})} />);
  expect(host!.querySelector(LIVE) === null).toBe(true);
});

test("FeatureTitle: motion never lands on the title text", () => {
  render(<FeatureTitle featureId="f1" window={window} workItem={item({ title: "Alpha" })} active />);
  const h1 = host!.querySelector<HTMLElement>('h1[data-slot="feature-title"]')!;
  expect(h1.className.split(/\s+/)).not.toContain("animate-live");
  expect(h1.querySelector('[data-slot="feature-live"]') === null).toBe(true);
});

test("FeatureTitle: a feature with no plan yet reads Planning", () => {
  render(<FeatureTitle featureId="f1" window={window} workItem={null} />);
  expect(host!.querySelector('h1[data-slot="feature-title"]') === null).toBe(false);
  const pill = host!.querySelector('[data-slot="feature-status"]')!;
  expect(pill.textContent).toBe("Planning");
  expect(pill.className.split(/\s+/)).toContain("pill-neutral");
});

test("FeatureTitle: the worker's own activity reads under the name, apart from the state", () => {
  planOf("blocked");
  render(<FeatureTitle featureId="f1" window={window} workItem={item({})} workerRunning />);
  expect(host!.querySelector('[data-slot="worker-activity"]')!.textContent).toBe("worker running");
  expect(host!.querySelector('[data-slot="feature-status"]')!.textContent).toBe("Blocked");
  view!.unmount();
  render(<FeatureTitle featureId="f1" window={window} workItem={item({})} />);
  expect(host!.querySelector('[data-slot="worker-activity"]')!.textContent).toBe("worker idle");
});

// A worker whose tmux window is gone: the same title, so its name
// keeps the whole line on a phone; that the window is missing reads on the
// line under it, with the worker's activity.
test("FeatureTitle without a window: the worker's name, and under it its activity and that its window is missing", () => {
  const name = "Fix the project-2 cache expiry for project-1 Issue #22";
  render(<FeatureTitle featureId="f1" window={null} featureName={name} workItem={item({ title: "" })} />);
  expect(host!.querySelector('h1[data-slot="feature-title"]')!.textContent).toBe(name);
  expect(host!.querySelector('[data-slot="worker-activity"]')!.textContent).toBe("worker idle · window missing");
  view!.unmount();
  render(<FeatureTitle featureId="f1" window={null} featureName={name} workItem={item({ title: "Wire project-2 cache expiry into project-1" })} workerRunning />);
  expect(host!.querySelector('h1[data-slot="feature-title"]')!.textContent).toBe("Wire project-2 cache expiry into project-1");
  expect(host!.querySelector('[data-slot="worker-activity"]')!.textContent).toBe("worker running · window missing");
});

// Waiting on a monitor: the line under the name says what the
// worker watches, unless it is running; a missing window still says so.
test("FeatureTitle: a worker waiting on a monitor says what it watches, under the name", () => {
  render(<FeatureTitle featureId="f1" window={window} workItem={item({})} waitingOn={{ lead: "Watching", label: "Codex PR48" }} />);
  expect(host!.querySelector('[data-slot="worker-activity"]')!.textContent).toBe("worker watching Codex PR48");
  view!.unmount();
  render(<FeatureTitle featureId="f1" window={window} workItem={item({})} waitingOn={{ lead: "Monitoring", label: "project-1 CI" }} workerRunning />);
  expect(host!.querySelector('[data-slot="worker-activity"]')!.textContent).toBe("worker running");
  view!.unmount();
  render(<FeatureTitle featureId="f1" window={null} featureName="w" workItem={item({})} waitingOn={{ lead: "Monitoring", label: "project-1 CI" }} />);
  expect(host!.querySelector('[data-slot="worker-activity"]')!.textContent).toBe("worker monitoring project-1 CI · window missing");
});
