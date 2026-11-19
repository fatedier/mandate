import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ProjectWorkers } from "@/routes/projects/ProjectWorkers";
import { useWorkItemsStore } from "@/store/work-items";
import { useWorkerPlansStore } from "@/store/worker-plans";
import { emptyPlan } from "@shared/api/plans";
import type { Project } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, type Mounted } from "../helpers/mount.js";
import { clientProject } from "../helpers/client-builders.js";

let view: Mounted | null = null;
afterEach(() => {
  // Unmount before the work items the section reads are reset under it.
  runCleanups();
  useWorkItemsStore.setState({ items: new Map() });
  useWorkerPlansStore.setState({ plans: new Map() });
});

function worker(id: string, name: string, extra: Partial<Project["workers"][number]> = {}) {
  return {
    id, projectId: "p1", name, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: `w-${id}`, ownership: "app", pinnedAt: null, createdAt: `2026-09-0${id.slice(-1)}T00:00:00Z`,
    updatedAt: "2026-09-10T00:00:00Z", archivedAt: null, tmuxStatus: "alive", ...extra
  } as Project["workers"][number];
}
function project(workers: Project["workers"]): Project {
  return clientProject("p1", {
    workingDir: "/tmp/project-1", isGit: true, tmuxSessionName: "md-project-1",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z", tmuxStatus: "alive", workers
  });
}
/** `failed`: its last wake failed, which puts it under attention. */
function item(workerId: string, failed: boolean): WorkItemDto {
  return {
    id: `wi-${workerId}`, workerId, projectId: "p1", title: `Item ${workerId}`,
    lastActivityAt: "2026-09-10T00:00:00Z",
    failedAt: failed ? "2026-09-10T00:00:00Z" : null, failedMessage: failed ? "boom" : null, failedKind: failed ? "error" : null
  } as unknown as WorkItemDto;
}

let at = "";
function Where() {
  const location = useLocation();
  at = location.pathname + location.search;
  return null;
}

function render(p: Project) {
  view = mount(
    <MemoryRouter>
      <ProjectWorkers project={p} />
      <Where />
    </MemoryRouter>
  );
  return view.host;
}

test("the workers have no New worker button: the manager starts workers", () => {
  const el = render(project([worker("f1", "alpha")]));
  expect([...el.querySelectorAll("button")].some((b) => /new feature/i.test(`${b.textContent} ${b.getAttribute("aria-label") ?? ""} ${b.title}`))).toBe(false);
});

test("a row and its Open go to the owner thread with the worker's tab open; an unowned one to the projects", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([
    ["wi-f1", item("f1", true)],
    ["wi-f2", item("f2", true)]
  ]) }));
  const el = render(project([worker("f1", "alpha", { ownerThreadId: "thr_a" }), worker("f2", "beta", { ownerThreadId: null })]));
  const opens = [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Open worker"]')];
  // Each row renders a touch and a pointer twin; the first two rows' first buttons.
  const first = opens.find((b) => b.closest("li")?.textContent?.includes("Item f1"))!;
  act(() => first.click());
  expect(at).toBe("/threads/thr_a?worker=f1");
  const second = opens.find((b) => b.closest("li")?.textContent?.includes("Item f2"))!;
  act(() => second.click());
  expect(at).toBe("/projects");
  // The row itself is a link to the same place.
  const rowLinks = [...el.querySelectorAll<HTMLAnchorElement>('a[data-slot="worker-row"]')].map((a) => [a.textContent?.includes("Item f1") ? "f1" : "f2", a.getAttribute("href")]);
  expect(new Set(rowLinks.map(([w, href]) => `${w} ${href}`))).toEqual(new Set(["f1 /threads/thr_a?worker=f1", "f2 /projects"]));
});

test("workers render as rows in one container, attention first, no Running eyebrow", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([
    ["wi-f1", item("f1", false)],
    ["wi-f2", item("f2", true)],
    ["wi-f3", item("f3", false)]
  ]) }));
  const el = render(project([worker("f1", "alpha"), worker("f2", "beta"), worker("f3", "gamma")]));
  const list = el.querySelector('[data-slot="worker-list"]')!;
  expect(list === null).toBe(false);
  expect(list.className.split(/\s+/)).toContain("bg-panel");
  const rows = Array.from(list.querySelectorAll('[data-slot="worker-row"]'));
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["top", "passive", "passive"]);
  expect(rows.map((r) => r.querySelector('[data-slot="worker-title"]')?.textContent)).toStrictEqual(["Item f2", "Item f1", "Item f3"]);
  expect(el.textContent).not.toContain("Running");
});

test("untracked workers (no work item) sit last in the same container", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([["wi-f1", item("f1", false)]]) }));
  const el = render(project([worker("f9", "orphan"), worker("f1", "alpha")]));
  const rows = Array.from(el.querySelectorAll('[data-slot="worker-row"]'));
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["passive", "untracked"]);
  // An untracked row shows the worker's name, a title: the body font, not mono.
  expect(rows[1]!.querySelector('[data-slot="worker-title"]')!.className.split(/\s+/)).not.toContain("font-mono");
});

test("every list item is a hairline-separated row: border-t, border-border-soft, first:border-t-0", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([["wi-f1", item("f1", false)], ["wi-f2", item("f2", false)]]) }));
  const el = render(project([worker("f1", "alpha"), worker("f2", "beta")]));
  const lis = Array.from(el.querySelectorAll('[data-slot="worker-list"] > li'));
  expect(lis.length).toBe(2);
  for (const li of lis) {
    const tokens = li.className.split(/\s+/);
    expect(tokens).toContain("border-t");
    expect(tokens).toContain("border-border-soft");
    expect(tokens).toContain("first:border-t-0");
  }
});

test("a pinned worker without a work item is untracked and sorts first; only the top row has Ack", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([
    ["wi-f1", item("f1", false)],
    ["wi-f2", item("f2", false)]
  ]) }));
  // f2's worker asks and rests: it waits for an answer, at the top with an Ack.
  act(() => useWorkerPlansStore.setState({ plans: new Map([["f2", { ...emptyPlan("f2"), openQuestions: ["Keep the old flag?"] }]]) }));
  const el = render(project([
    worker("f1", "alpha"),
    worker("f2", "beta"),
    worker("f7", "pinned-orphan", { pinnedAt: "2026-09-09T00:00:00Z" })
  ]));
  const rows = Array.from(el.querySelectorAll('[data-slot="worker-row"]'));
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["untracked", "top", "passive"]);
  const acksIn = (row: Element) => Array.from(row.querySelectorAll("button"))
    .filter((b) => (b.textContent ?? "").trim() === "Ack").length;
  expect(acksIn(rows[1]!)).toBeGreaterThan(0);
  expect(acksIn(rows[2]!)).toBe(0);
});

