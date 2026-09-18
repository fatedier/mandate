import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ProjectSection } from "@/routes/projects/ProjectSection";
import { useWorkItemsStore } from "@/store/work-items";
import type { Project } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useWorkItemsStore.setState({ items: new Map() });
});

function feature(id: string, name: string, extra: Partial<Project["features"][number]> = {}) {
  return {
    id, projectId: "p1", name, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: `w-${id}`, ownership: "app", pinnedAt: null, createdAt: `2026-09-0${id.slice(-1)}T00:00:00Z`,
    updatedAt: "2026-09-10T00:00:00Z", archivedAt: null, tmuxAlive: true, tmuxStatus: "alive", ...extra
  } as Project["features"][number];
}
function project(features: Project["features"]): Project {
  return {
    id: "p1", name: "frp", workingDir: "/tmp/frp", isGit: true, gitRemote: null, tmuxSessionName: "md-frp",
    ownership: "app", sortOrder: 0, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z",
    archivedAt: null, tmuxAlive: true, tmuxStatus: "alive", features
  } as Project;
}
function item(featureId: string, needsUser: WorkItemDto["needsUser"], phase: WorkItemDto["phase"] = "working"): WorkItemDto {
  return {
    id: `wi-${featureId}`, featureId, projectId: "p1", title: `Item ${featureId}`, phase, needsUser,
    summary: null, phaseDetail: null, canvasId: null, lastActivityAt: "2026-09-10T00:00:00Z"
  } as unknown as WorkItemDto;
}

function render(p: Project) {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter>
        <ProjectSection project={p} canMoveUp={false} canMoveDown={false} onMoveToTop={() => {}} onMoveUp={() => {}} onMoveDown={() => {}} />
      </MemoryRouter>
    );
  });
  return host!;
}

test("features render as rows in one container, attention first, no Running eyebrow", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([
    ["wi-f1", item("f1", null)],
    ["wi-f2", item("f2", "review")],
    ["wi-f3", item("f3", null, "done")]
  ]) }));
  const el = render(project([feature("f1", "alpha"), feature("f2", "beta"), feature("f3", "gamma")]));
  const list = el.querySelector('[data-slot="feature-list"]')!;
  expect(list === null).toBe(false);
  expect(list.className.split(/\s+/)).toContain("bg-panel");
  const rows = Array.from(list.querySelectorAll('[data-slot="feature-row"]'));
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["top", "passive", "passive"]);
  expect(rows.map((r) => r.querySelector('[data-slot="feature-title"]')?.textContent)).toEqual(["Item f2", "Item f1", "Item f3"]);
  expect(el.textContent).not.toContain("Running");
  expect(el.querySelector('[data-slot="project-header"]')?.textContent).toContain("frp");
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
  act(() => useWorkItemsStore.setState({ items: new Map([["wi-f1", item("f1", null)]]) }));
  const el = render(project([feature("f9", "orphan"), feature("f1", "alpha")]));
  const rows = Array.from(el.querySelectorAll('[data-slot="feature-row"]'));
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["passive", "untracked"]);
});

test("every list item is a hairline-separated row: border-t, border-border-soft, first:border-t-0", () => {
  act(() => useWorkItemsStore.setState({ items: new Map([["wi-f1", item("f1", null)], ["wi-f2", item("f2", null)]]) }));
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
    ["wi-f1", item("f1", null)],
    ["wi-f2", item("f2", "review")]
  ]) }));
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
  act(() => useWorkItemsStore.setState({ items: new Map([["wi-f1", item("f1", null)]]) }));
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
    ["wi-f1", item("f1", null)], ["wi-f2", item("f2", null)], ["wi-f3", item("f3", null)]
  ]) }));
  const full = render(project([feature("f1", "a"), feature("f2", "b"), feature("f3", "c")]));
  const count = full.querySelector('[data-slot="feature-count"]');
  expect(count === null).toBe(false);
  expect(count!.textContent).toBe("3");
  act(() => root?.unmount());
  host?.remove();
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
