import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { WorkersOverview } from "@/routes/threads/WorkersOverview";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useWakeActivityStore } from "@/store/wake-activity";
import { formatElapsedClock } from "@/lib/format";
import { emptyPlan, type FeaturePlanDto, type PlanStepDto } from "@shared/api/plans";
import type { ThreadWorker } from "@/hooks/useThreadWorkers";
import { runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mount, settle } from "../helpers/mount.js";
import { threadWorker } from "../helpers/client-builders.js";

test("a failed archived list says so, and reopening Archived tries again", async () => {
  let fail = true;
  mockFetch(() => (fail
    ? new Response("down", { status: 502 })
    : Response.json({ workers: [{ featureId: "old", name: "old-worker", projectId: "p1", projectName: "project-1", workerThreadId: null, archivedAt: "2026-09-27T00:00:00Z" }] })));
  const { host } = mount(<WorkersOverview threadId="thr_a" workers={[]} onOpen={() => {}} onOpenArchived={() => {}} onOpenCanvas={() => {}} />);
  const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => { toggle().click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(host.textContent).toContain("Could not load archived workers.");
  expect(host.textContent).not.toContain("None.");
  fail = false;
  await act(async () => { toggle().click(); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { toggle().click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(host.textContent).toContain("old-worker");
  // An archived worker's name is a title too: the body font.
  const name = [...host.querySelectorAll("span")].find((s) => s.textContent === "old-worker")!;
  expect(name.className.split(/\s+/)).not.toContain("font-mono");
});

test("a group of workers is headed in sentence case at the rows' size", () => {
  const worker = threadWorker("f1", { name: "Fix the project-2 cache expiry for project-1 Issue #22", projectSlug: "md-project-1", featureSlug: "project1_issue_22", running: true });
  const { host } = mount(<WorkersOverview threadId="thr_a" workers={[worker]} onOpen={() => {}} onOpenArchived={() => {}} onOpenCanvas={() => {}} />);
  const heading = host.querySelector("section h3")!;
  expect(heading.textContent).toBe("In progress");
  expect(heading.className.split(/\s+/)).toContain("label-group");
});

// A row under a group does not repeat the group's name (every
// row under "Failed" said "Failed"); one that adds something stays, and so
// does a running worker's, which is the live signal and reads Running, as
// the strip line does. The heading starts where the rows' text does.
test("a row says its state only when the group's name does not, or it is running", () => {
  const base = { projectId: "p1", projectName: "project-1", projectSlug: "md-project-1", ownerThreadId: "thr_a", watching: null, asking: false, stepInProgress: false };
  const workers = [
    { ...base, featureId: "f1", name: "failed-one", featureSlug: "a", state: "in_progress" as const, waiting: "failed" as const, running: false },
    { ...base, featureId: "f2", name: "planning-one", featureSlug: "b", state: "planning" as const, waiting: null, running: false },
    { ...base, featureId: "f3", name: "working-one", featureSlug: "c", state: "in_progress" as const, waiting: null, running: true },
    { ...base, featureId: "f4", name: "resting-one", featureSlug: "d", state: "in_progress" as const, waiting: null, running: false }
  ];
  const { host } = mount(<WorkersOverview threadId="thr_a" workers={workers} onOpen={() => {}} onOpenArchived={() => {}} onOpenCanvas={() => {}} />);
  const row = (name: string) => host.querySelector(`[data-worker="${name}"]`)!;
  const state = (name: string) => row(name).querySelector("[data-slot=worker-state]")?.textContent ?? null;
  expect(state("failed-one")).toBeNull();
  expect(state("planning-one")).toBe("Planning");
  expect(state("working-one")).toBe("Running");
  expect(state("resting-one")).toBeNull();
  const heading = host.querySelector("section h3")!.className.split(/\s+/);
  const rowPad = row("failed-one").className.split(/\s+/);
  expect(heading).toContain("px-2");
  expect(rowPad).toContain("px-2");
});

// A worker waiting on a monitor reads Watching (a pane) or Monitoring (a
// command), as its chat's waiting line does: under "In progress"
// it said nothing, so the thread's watching ring named no worker. A running
// worker's live state, and a waiting-on-you state, still win.
test("a worker waiting on a monitor says Watching or Monitoring; running, or waiting for an answer, wins", () => {
  const base = { projectId: "p1", projectName: "project-1", projectSlug: "md-project-1", ownerThreadId: "thr_a", state: "in_progress" as const, asking: false, stepInProgress: false };
  const workers = [
    { ...base, featureId: "f1", name: "pane-one", featureSlug: "a", waiting: null, running: false, watching: "pane" as const },
    { ...base, featureId: "f2", name: "ci-one", featureSlug: "b", waiting: null, running: false, watching: "command" as const },
    { ...base, featureId: "f3", name: "busy-one", featureSlug: "c", waiting: null, running: true, watching: "pane" as const },
    { ...base, featureId: "f4", name: "asked-one", featureSlug: "d", state: "asking" as const, asking: true, waiting: null, running: false, watching: "pane" as const }
  ];
  const { host } = mount(<WorkersOverview threadId="thr_a" workers={workers} onOpen={() => {}} onOpenArchived={() => {}} onOpenCanvas={() => {}} />);
  const state = (name: string) => host.querySelector(`[data-worker="${name}"] [data-slot=worker-state]`);
  expect(state("pane-one")?.textContent).toBe("Watching");
  expect(state("ci-one")?.textContent).toBe("Monitoring");
  expect(state("pane-one")!.className.split(/\s+/)).toContain("text-faint");
  expect(state("busy-one")?.textContent).toBe("Running");
  expect(state("busy-one")!.className.split(/\s+/)).toContain("text-live");
  // Under "Waiting for an answer" its group says it; the monitor adds nothing.
  expect(host.querySelector('section[aria-label="Waiting for an answer"] [data-worker="asked-one"]')).not.toBeNull();
  expect(state("asked-one") === null).toBe(true);
});

// As a monitor's: the thread's watching ring names the worker that waits.
const waitRows: Array<{ name: string; watching: "subagent" | "background-command" | "alarm"; label: string }> = [
  { name: "a worker waiting on its subagent's result says so", watching: "subagent", label: "Waiting for a subagent" },
  { name: "a worker waiting on a command it runs in the background says so", watching: "background-command", label: "Waiting for a command" },
  { name: "a worker waiting on its alarm says so", watching: "alarm", label: "Waiting for a wake" }
];

test.each(waitRows)("$name", ({ watching, label }) => {
  const base = { projectId: "p1", projectName: "project-1", projectSlug: "md-project-1", ownerThreadId: "thr_a", state: "in_progress" as const, asking: false, stepInProgress: false };
  const workers = [{ ...base, featureId: "f1", name: "retry-map", featureSlug: "a", waiting: null, running: false, watching }];
  const { host } = mount(<WorkersOverview threadId="thr_a" workers={workers} onOpen={() => {}} onOpenArchived={() => {}} onOpenCanvas={() => {}} />);
  expect(host.querySelector('[data-worker="retry-map"] [data-slot=worker-state]')?.textContent).toBe(label);
});

// ---- Cards, done lines and the thread's reports ----

const NOW = Date.parse("2026-10-28T09:20:00.000Z");
const step = (id: number, title: string, status: PlanStepDto["status"], completedAt: string | null = null): PlanStepDto => ({
  id, title, status, note: null, createdAt: "2026-10-28T08:00:00.000Z", startedAt: null, blockedAt: null, completedAt, updatedAt: "2026-10-28T08:00:00.000Z"
});
const planOf = (featureId: string, over: Partial<FeaturePlanDto>): FeaturePlanDto => ({ ...emptyPlan(featureId), updatedAt: "2026-10-28T08:00:00.000Z", ...over });
const overview = (workers: ThreadWorker[], onOpenCanvas: (id: string) => void = () => {}) =>
  mount(<WorkersOverview threadId="thr_a" workers={workers} onOpen={() => {}} onOpenArchived={() => {}} onOpenCanvas={onOpenCanvas} />).host;

afterEach(() => {
  runCleanups();
  setSystemTime();
  useFeaturePlansStore.setState({ plans: new Map() });
  useWakeActivityStore.setState({ activeByFeatureId: new Map() });
});

function noCanvases() {
  mockFetch(({ url }) => (url.endsWith("/canvases") ? Response.json({ canvases: [] }) : Response.json({ workers: [] })));
}

test("a worker at work is a card: its state and clock as the strip says them, the step it is on, its goal", async () => {
  setSystemTime(new Date(NOW));
  noCanvases();
  useFeaturePlansStore.getState().upsert(planOf("f1", {
    goal: "Send 10% of cn traffic to the new server first.",
    steps: [step(1, "Build", "done"), step(2, "Deploy", "done"), step(3, "Watch cn traffic", "in_progress"), step(4, "Widen", "pending"), step(5, "Report", "pending")]
  }), "fetch");
  useWakeActivityStore.setState({ activeByFeatureId: new Map([["f1", { wakeId: "wk1", threadId: "thr_w", startedAt: new Date(NOW - 240_000).toISOString() } as never]]) });
  const host = overview([threadWorker("f1", { name: "cn canary", running: true, state: "in_progress", stepInProgress: true })]);
  await settle();
  const card = host.querySelector('[data-worker="cn canary"]')!;
  expect(card.querySelector("[data-slot=worker-state]")!.textContent).toBe(`Running · ${formatElapsedClock(240_000)}`);
  // On a touch screen a card is at least 44px: its lines sit in its middle.
  expect(card.className.split(/\s+/)).toEqual(expect.arrayContaining(["pointer-coarse:min-h-11", "justify-center"]));
  // A long label gives way; its clock stays.
  expect(card.querySelector("[data-slot=worker-state-label]")!.className.split(/\s+/)).toContain("truncate");
  expect(card.querySelector("[data-slot=worker-clock]")!.className.split(/\s+/)).toContain("shrink-0");
  expect(card.querySelector("[data-slot=worker-progress]")!.textContent).toBe("Step 3 of 5 · Watch cn traffic");
  expect(card.querySelector("[data-slot=worker-goal]")!.textContent).toBe("Goal: Send 10% of cn traffic to the new server first.");
});

test("a worker with no step at work says how many steps are done", async () => {
  noCanvases();
  useFeaturePlansStore.getState().upsert(planOf("f2", { steps: [step(1, "a", "done"), step(2, "b", "done"), step(3, "c", "pending"), step(4, "d", "pending")] }), "fetch");
  const host = overview([threadWorker("f2", { name: "docs pass", state: "paused" })]);
  await settle();
  expect(host.querySelector('[data-worker="docs pass"] [data-slot=worker-progress]')!.textContent).toBe("2 of 4 steps");
  // No goal, no goal line.
  expect(host.querySelector('[data-worker="docs pass"] [data-slot=worker-goal]') === null).toBe(true);
});

test("done workers are one line each, newest first, three before the rest fold", async () => {
  setSystemTime(new Date(NOW));
  noCanvases();
  const names = ["release", "rollback drill", "cert renewal", "docs site", "cache sweep"];
  names.forEach((name, i) => {
    useFeaturePlansStore.getState().upsert(planOf(`d${i}`, {
      conclusion: i === 0 ? "Shipped to all three. The canary waits for review." : `${name} finished.`,
      steps: [step(1, "only", "done", `2026-10-28T0${i}:00:00.000Z`)]
    }), "fetch");
  });
  const host = overview(names.map((name, i) => threadWorker(`d${i}`, { name, state: "done" })));
  await settle();
  const lines = () => [...host.querySelectorAll<HTMLElement>("[data-slot=done-worker]")];
  expect(host.querySelector('section[aria-label="Done"] h3')!.textContent).toBe("Done · 5");
  // Newest first: the last one finished at 04:00.
  expect(lines().map((l) => l.querySelector("[data-slot=done-name]")!.textContent)).toEqual(["cache sweep", "docs site", "cert renewal"]);
  const more = [...host.querySelectorAll("button")].find((b) => b.textContent === "2 more done")!;
  await act(async () => { more.click(); });
  expect(lines()).toHaveLength(5);
  const first = lines().at(-1)!.textContent!;
  expect(first).toContain("Shipped to all three.");
  expect(first).not.toContain("The canary waits");
  // Done workers are not cards.
  expect(host.querySelector('[data-worker="release"]') === null).toBe(true);
});

const listed = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `cnv_Listed0000${i}`, title: i === 1 ? "Rollout plan" : `Report ${i}`, kind: i === 1 ? "design" : "report",
  scope: i === 1 ? "manager" : "worker", scopeId: i === 1 ? null : "w1", threadId: "thr_a",
  createdAt: "2026-10-28T08:00:00.000Z", updatedAt: `2026-10-28T0${9 - i}:00:00.000Z`,
  projectId: "p1", projectName: "project-1", projectSlug: "md-project-1",
  featureId: i === 1 ? null : "w1", featureName: i === 1 ? null : "release notes", featureSlug: i === 1 ? null : "notes"
}));

test("the thread's reports and canvases list newest first, three before the rest fold, and open beside the chat", async () => {
  setSystemTime(new Date(NOW));
  mockFetch(({ url }) => (url.endsWith("/api/agents/manager/threads/thr_a/canvases") ? Response.json({ canvases: listed(4) }) : Response.json({ workers: [] })));
  const opened: string[] = [];
  const host = overview([], (id) => opened.push(id));
  await settle();
  const section = host.querySelector('section[aria-label="Reports and canvases"]')!;
  expect(section.querySelector("h3")!.textContent).toBe("Reports and canvases · 4");
  const rows = () => [...section.querySelectorAll<HTMLElement>("[data-slot=thread-canvas]")];
  expect(rows().map((r) => r.querySelector("[data-slot=thread-canvas-title]")!.textContent)).toEqual(["Report 0", "Rollout plan", "Report 2"]);
  expect(rows()[0]!.textContent).toContain("release notes ·");
  expect(rows()[1]!.textContent).toContain("Manager ·");
  await act(async () => { [...section.querySelectorAll("button")].find((b) => b.textContent === "1 more")!.click(); });
  expect(rows()).toHaveLength(4);
  await act(async () => { rows()[1]!.click(); });
  expect(opened).toEqual([listed(4)[1]!.id]);
});

test("no canvases, no Reports and canvases section", async () => {
  noCanvases();
  const host = overview([threadWorker("f1", { name: "cn canary" })]);
  await settle();
  expect(host.querySelector('section[aria-label="Reports and canvases"]') === null).toBe(true);
});

test("a new canvas in the thread shows without a reload", async () => {
  let canvases: unknown[] = [];
  mockFetch(({ url }) => (url.endsWith("/canvases") ? Response.json({ canvases }) : Response.json({ workers: [] })));
  const host = overview([]);
  await settle();
  expect(host.querySelector('section[aria-label="Reports and canvases"]') === null).toBe(true);
  canvases = listed(1);
  await act(async () => { window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: listed(1)[0]!.id, featureId: "w1" } })); });
  await new Promise((r) => setTimeout(r, 150));
  await settle();
  expect(host.querySelectorAll("[data-slot=thread-canvas]")).toHaveLength(1);
});

// A plan re-aimed counts only its current work: the steps done for an
// earlier goal are not this goal's progress.
test("a re-aimed worker's card counts the current goal's steps only", async () => {
  noCanvases();
  const old = (id: number) => ({ ...step(id, `old ${id}`, "done"), createdAt: "2026-10-27T08:00:00.000Z" });
  useFeaturePlansStore.getState().upsert(planOf("f3", {
    goal: "Widen to SG.",
    goalHistory: [{ goal: "Ship to cn first.", changedAt: "2026-10-28T07:00:00.000Z" }],
    steps: [old(1), old(2), old(3), step(4, "Deploy SG", "done"), step(5, "Watch SG traffic", "in_progress"), step(6, "Report", "pending")]
  }), "fetch");
  const host = overview([threadWorker("f3", { name: "sg rollout", state: "in_progress" })]);
  await settle();
  expect(host.querySelector('[data-worker="sg rollout"] [data-slot=worker-progress]')!.textContent).toBe("Step 2 of 3 · Watch SG traffic");
});

// A worker restored into this thread (or moved out) brings its reports with
// it (or takes them): the list is read again when the thread's workers change,
// not only on a canvas event.
test("the thread's reports are read again when its workers change", async () => {
  let reads = 0;
  mockFetch(({ url }) => {
    if (!url.endsWith("/canvases")) return Response.json({ workers: [] });
    reads += 1;
    return Response.json({ canvases: reads === 1 ? [] : listed(1) });
  });
  const props = { threadId: "thr_a", onOpen: () => {}, onOpenArchived: () => {}, onOpenCanvas: () => {} };
  const view = mount(<WorkersOverview {...props} workers={[threadWorker("f1")]} />);
  await settle();
  expect(view.host.querySelector('section[aria-label="Reports and canvases"]') === null).toBe(true);
  view.rerender(<WorkersOverview {...props} workers={[threadWorker("f1"), threadWorker("w1", { name: "release notes" })]} />);
  await new Promise((r) => setTimeout(r, 50));
  await settle();
  expect(view.host.querySelectorAll("[data-slot=thread-canvas]")).toHaveLength(1);
});

// A long name gives way in a narrow pane: what follows it (the conclusion,
// the time, the canvas's title) stays in the row.
test("long names give way, the times stay", async () => {
  setSystemTime(new Date(NOW));
  mockFetch(({ url }) => (url.endsWith("/canvases") ? Response.json({ canvases: listed(1) }) : Response.json({ workers: [] })));
  useFeaturePlansStore.getState().upsert(planOf("d0", { conclusion: "Shipped.", steps: [step(1, "only", "done", "2026-10-28T08:00:00.000Z")] }), "fetch");
  const host = overview([threadWorker("d0", { name: "a worker with a very long name indeed", state: "done" })]);
  await settle();
  const classes = (selector: string) => host.querySelector(selector)!.className.split(/\s+/);
  expect(classes("[data-slot=done-name]")).toEqual(expect.arrayContaining(["truncate", "max-w-[50%]"]));
  expect(classes("[data-slot=done-time]")).toContain("shrink-0");
  expect(classes("[data-slot=thread-canvas-by]")).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
  expect(classes("[data-slot=thread-canvas-time]")).toContain("shrink-0");
});

// An archived worker restored into another thread was never among this
// thread's active workers: the restore itself says the list may have changed.
test("the thread's reports are read again when a worker is restored or moved anywhere", async () => {
  let reads = 0;
  mockFetch(({ url }) => {
    if (!url.endsWith("/canvases")) return Response.json({ workers: [] });
    reads += 1;
    return Response.json({ canvases: reads === 1 ? listed(1) : [] });
  });
  const host = overview([threadWorker("f1")]);
  await settle();
  expect(host.querySelectorAll("[data-slot=thread-canvas]")).toHaveLength(1);
  await act(async () => { window.dispatchEvent(new CustomEvent("mandate:thread-workers-changed")); });
  await new Promise((r) => setTimeout(r, 150));
  await settle();
  expect(host.querySelector('section[aria-label="Reports and canvases"]') === null).toBe(true);
});
