import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ProjectSection } from "@/routes/projects/ProjectSection";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlansStore } from "@/store/feature-plans";
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
  useFeaturePlansStore.setState({ plans: new Map() });
});

function feature(id: string, name: string, extra: Partial<Project["features"][number]> = {}) {
  return {
    id, projectId: "p1", name, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: `w-${id}`, ownership: "app", pinnedAt: null, createdAt: `2026-09-0${id.slice(-1)}T00:00:00Z`,
    updatedAt: "2026-09-10T00:00:00Z", archivedAt: null, tmuxAlive: true, tmuxStatus: "alive", ...extra
  } as Project["features"][number];
}
function project(features: Project["features"]): Project {
  return clientProject("p1", {
    workingDir: "/tmp/project-1", isGit: true, tmuxSessionName: "md-project-1",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z", tmuxStatus: "alive", features
  });
}
/** `failed`: its last wake failed, which puts it under attention. */
function item(featureId: string, failed: boolean): WorkItemDto {
  return {
    id: `wi-${featureId}`, featureId, projectId: "p1", title: `Item ${featureId}`,
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
      <ProjectSection project={p} canMoveUp={false} canMoveDown={false} onMoveToTop={() => {}} onMoveUp={() => {}} onMoveDown={() => {}} />
      <Where />
    </MemoryRouter>
  );
  return view.host;
}

test("a project has no New feature button: the manager starts workers", () => {
  const el = render(project([feature("f1", "alpha")]));
  expect([...el.querySelectorAll("button")].some((b) => /new feature/i.test(b.textContent ?? b.getAttribute("aria-label") ?? ""))).toBe(false);
});

test("a row's Open goes to the owner thread with the worker's tab open; an unowned one to its page", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([
    ["wi-f1", item("f1", true)],
    ["wi-f2", item("f2", true)]
  ]) }));
  const el = render(project([feature("f1", "alpha", { ownerThreadId: "thr_a" }), feature("f2", "beta", { ownerThreadId: null })]));
  const opens = [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Open worker"]')];
  // Each row renders a touch and a pointer twin; the first two rows' first buttons.
  const first = opens.find((b) => b.closest("li")?.textContent?.includes("Item f1"))!;
  act(() => first.click());
  expect(at).toBe("/threads/thr_a?worker=f1");
  const second = opens.find((b) => b.closest("li")?.textContent?.includes("Item f2"))!;
  act(() => second.click());
  expect(at).toBe("/projects/md-project-1/features/w-f2");
});

test("features render as rows in one container, attention first, no Running eyebrow", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([
    ["wi-f1", item("f1", false)],
    ["wi-f2", item("f2", true)],
    ["wi-f3", item("f3", false)]
  ]) }));
  const el = render(project([feature("f1", "alpha"), feature("f2", "beta"), feature("f3", "gamma")]));
  const list = el.querySelector('[data-slot="feature-list"]')!;
  expect(list === null).toBe(false);
  expect(list.className.split(/\s+/)).toContain("bg-panel");
  const rows = Array.from(list.querySelectorAll('[data-slot="feature-row"]'));
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["top", "passive", "passive"]);
  expect(rows.map((r) => r.querySelector('[data-slot="feature-title"]')?.textContent)).toStrictEqual(["Item f2", "Item f1", "Item f3"]);
  expect(el.textContent).not.toContain("Running");
  expect(el.querySelector('[data-slot="project-header"]')?.textContent).toContain("project-1");
});

test("an empty project is one line in the header and renders no container", () => {
  const el = render(project([]));
  expect(el.querySelector('[data-slot="feature-list"]') === null).toBe(true);
  const empty = el.querySelector('[data-slot="project-empty"]');
  expect(empty === null).toBe(false);
  expect(empty!.textContent).toContain("No features yet");
  expect(empty!.closest('[data-slot="project-header"]') === null).toBe(false);
});

test("untracked features (no work item) sit last in the same container", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([["wi-f1", item("f1", false)]]) }));
  const el = render(project([feature("f9", "orphan"), feature("f1", "alpha")]));
  const rows = Array.from(el.querySelectorAll('[data-slot="feature-row"]'));
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["passive", "untracked"]);
  // An untracked row shows the worker's name, a title: the body font, not mono.
  expect(rows[1]!.querySelector('[data-slot="feature-title"]')!.className.split(/\s+/)).not.toContain("font-mono");
});

test("every list item is a hairline-separated row: border-t, border-border-soft, first:border-t-0", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([["wi-f1", item("f1", false)], ["wi-f2", item("f2", false)]]) }));
  const el = render(project([feature("f1", "alpha"), feature("f2", "beta")]));
  const lis = Array.from(el.querySelectorAll('[data-slot="feature-list"] > li'));
  expect(lis.length).toBe(2);
  for (const li of lis) {
    const tokens = li.className.split(/\s+/);
    expect(tokens).toContain("border-t");
    expect(tokens).toContain("border-border-soft");
    expect(tokens).toContain("first:border-t-0");
  }
});

test("a pinned feature without a work item is untracked and sorts first; only the top row has Ack", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([
    ["wi-f1", item("f1", false)],
    ["wi-f2", item("f2", false)]
  ]) }));
  // f2's worker asks and rests: it waits for an answer, at the top with an Ack.
  act(() => useFeaturePlansStore.setState({ plans: new Map([["f2", { ...emptyPlan("f2"), openQuestions: ["Keep the old flag?"] }]]) }));
  const el = render(project([
    feature("f1", "alpha"),
    feature("f2", "beta"),
    feature("f7", "pinned-orphan", { pinnedAt: "2026-09-09T00:00:00Z" })
  ]));
  const rows = Array.from(el.querySelectorAll('[data-slot="feature-row"]'));
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["untracked", "top", "passive"]);
  const acksIn = (row: Element) => Array.from(row.querySelectorAll("button"))
    .filter((b) => (b.textContent ?? "").trim() === "Ack").length;
  expect(acksIn(rows[1]!)).toBeGreaterThan(0);
  expect(acksIn(rows[2]!)).toBe(0);
});

test("a project section is exactly header + one feature list", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([["wi-f1", item("f1", false)]]) }));
  const el = render(project([feature("f1", "alpha"), feature("f9", "orphan")]));
  const section = el.querySelector("section")!;
  expect(section === null).toBe(false);
  expect(section.children.length).toBe(2);
  expect(section.children[0]!.getAttribute("data-slot")).toBe("project-header");
  expect(section.children[1]!.getAttribute("data-slot")).toBe("feature-list");
  expect(el.querySelectorAll('[data-slot="feature-list"]').length).toBe(1);
});

test("the feature count is present for three features and absent for an empty project", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([
    ["wi-f1", item("f1", false)], ["wi-f2", item("f2", false)], ["wi-f3", item("f3", false)]
  ]) }));
  const full = render(project([feature("f1", "a"), feature("f2", "b"), feature("f3", "c")]));
  const count = full.querySelector('[data-slot="feature-count"]');
  expect(count === null).toBe(false);
  expect(count!.textContent).toBe("3");
  view!.unmount();
  const empty = render(project([]));
  expect(empty.querySelector('[data-slot="feature-count"]') === null).toBe(true);
});

test("session-missing hides its text below md but keeps the icon and title", () => {
  const p = { ...project([]), tmuxStatus: "gone", ownership: "app" } as Project;
  const el = render(p);
  const text = Array.from(el.querySelectorAll("span"))
    .find((s) => (s.textContent ?? "").trim() === "session missing" && s.children.length === 0);
  expect(text === undefined).toBe(false);
  expect(text!.className.split(/\s+/)).toContain("hidden");
  expect(text!.className.split(/\s+/)).toContain("md:inline");
  const wrapper = text!.parentElement!;
  expect(wrapper.getAttribute("title")).toBe("tmux session was killed externally — click Restore to rebuild");
  const icon = wrapper.querySelector("svg");
  expect(icon === null).toBe(false);
  expect(icon!.getAttribute("class") ?? "").not.toMatch(/(^|\s)md:/);
  expect(icon!.getAttribute("class") ?? "").not.toMatch(/(^|\s)hidden(\s|$)/);
});
