import { expect, test } from "bun:test";
import { buildBreadcrumb } from "../src/client/lib/breadcrumb.js";
import type { Project } from "../src/client/store/projects.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-id",
    name: "Mandate",
    workingDir: "/tmp",
    isGit: true,
    gitRemote: null,
    tmuxSessionName: "md-mandate",
    ownership: "app",
    sortOrder: 0,
    createdAt: "x", updatedAt: "x", archivedAt: null,
    tmuxAlive: true,
    features: [],
    ...overrides
  };
}

test("buildBreadcrumb: /projects → [Home (current)] — the band matches the nav item", () => {
  expect(buildBreadcrumb({ pathname: "/projects", bySlug: {} }))
    .toEqual([{ label: "Home", current: true }]);
});

test("buildBreadcrumb: /sessions → [Sessions (current)]", () => {
  expect(buildBreadcrumb({ pathname: "/sessions", bySlug: {} }))
    .toEqual([{ label: "Sessions", current: true }]);
});

test("buildBreadcrumb: /activity → [Activity (current)]", () => {
  expect(buildBreadcrumb({ pathname: "/activity", bySlug: {} }))
    .toEqual([{ label: "Activity", current: true }]);
});

test("buildBreadcrumb: /memory → [Memory (current)]", () => {
  expect(buildBreadcrumb({ pathname: "/memory", bySlug: {} }))
    .toEqual([{ label: "Memory", current: true }]);
});

test("buildBreadcrumb: canvas detail has no link to a global gallery", () => {
  expect(buildBreadcrumb({ pathname: "/canvas/cnv_123", bySlug: {} }))
    .toEqual([
      { label: "Canvas" },
      { label: "cnv_123", current: true, mono: true }
    ]);
});

test("buildBreadcrumb: /settings → [Settings (current)]", () => {
  expect(buildBreadcrumb({ pathname: "/settings", bySlug: {} }))
    .toEqual([{ label: "Settings", current: true }]);
});

test("buildBreadcrumb: feature route resolves project + feature names", () => {
  const project = makeProject({
    tmuxSessionName: "md-mandate",
    name: "Mandate",
    features: [{
      id: "f1", projectId: "proj-id", name: "Voice agent",
      mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
      tmuxWindowName: "voice-agent", ownership: "app", pinnedAt: null,
      createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true
    }]
  });
  expect(buildBreadcrumb({
    pathname: "/projects/md-mandate/features/voice-agent",
    bySlug: { "md-mandate": project }
  })).toEqual([
    { label: "Mandate", href: "/projects" },
    { label: "Voice agent", current: true }
  ]);
});

test("buildBreadcrumb: feature pane route adds pane segment with linkable feature", () => {
  const project = makeProject({
    tmuxSessionName: "md-mandate",
    name: "Mandate",
    features: [{
      id: "f1", projectId: "proj-id", name: "Voice agent",
      mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
      tmuxWindowName: "voice-agent", ownership: "app", pinnedAt: null,
      createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true
    }]
  });
  expect(buildBreadcrumb({
    pathname: "/projects/md-mandate/features/voice-agent/pane/p1",
    bySlug: { "md-mandate": project }
  })).toEqual([
    { label: "Mandate", href: "/projects" },
    { label: "Voice agent", href: "/projects/md-mandate/features/voice-agent?tab=terminal" },
    { label: "p1", current: true, mono: true }
  ]);
});

test("buildBreadcrumb: tmux pane id (%37) is decoded once for display", () => {
  const project = makeProject({
    tmuxSessionName: "md-mandate",
    name: "Mandate",
    features: [{
      id: "f1", projectId: "proj-id", name: "init",
      mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
      tmuxWindowName: "init", ownership: "app", pinnedAt: null,
      createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true
    }]
  });
  expect(buildBreadcrumb({
    pathname: "/projects/md-mandate/features/init/pane/%2537",
    bySlug: { "md-mandate": project }
  })).toEqual([
    { label: "Mandate", href: "/projects" },
    { label: "init", href: "/projects/md-mandate/features/init?tab=terminal" },
    { label: "%37", current: true, mono: true }
  ]);
});

test("buildBreadcrumb: session detail route", () => {
  expect(buildBreadcrumb({ pathname: "/sessions/sess-1", bySlug: {} }))
    .toEqual([
      { label: "sessions", href: "/sessions" },
      { label: "sess-1", current: true, mono: true }
    ]);
});

test("buildBreadcrumb: session pane route adds pane segment with linkable window", () => {
  expect(buildBreadcrumb({
    pathname: "/sessions/sess-1/windows/dev/pane/%2537",
    bySlug: {}
  })).toEqual([
    { label: "sessions", href: "/sessions" },
    { label: "sess-1", href: "/sessions/sess-1", mono: true },
    { label: "dev", href: "/sessions/sess-1/windows/dev", mono: true },
    { label: "%37", current: true, mono: true }
  ]);
});

test("buildBreadcrumb: session window route", () => {
  expect(buildBreadcrumb({
    pathname: "/sessions/sess-1/windows/win-2",
    bySlug: {}
  })).toEqual([
    { label: "sessions", href: "/sessions" },
    { label: "sess-1", href: "/sessions/sess-1", mono: true },
    { label: "win-2", current: true, mono: true }
  ]);
});

test("buildBreadcrumb: unknown project slug falls back to slug literal", () => {
  expect(buildBreadcrumb({
    pathname: "/projects/unknown/features/foo",
    bySlug: {}
  })).toEqual([
    { label: "unknown", href: "/projects" },
    { label: "foo", current: true }
  ]);
});

test("buildBreadcrumb: unknown route falls back to first segment", () => {
  expect(buildBreadcrumb({ pathname: "/something-unmapped", bySlug: {} }))
    .toEqual([{ label: "something-unmapped", current: true }]);
});

test("buildBreadcrumb: empty pathname falls back to Home", () => {
  expect(buildBreadcrumb({ pathname: "/", bySlug: {} }))
    .toEqual([{ label: "Home", current: true }]);
});

test("marks session/window/pane segments as mono", () => {
  const segs = buildBreadcrumb({ pathname: "/sessions/mysess/windows/win1/pane/%252", bySlug: {} });
  expect(segs.map((s) => Boolean(s.mono))).toEqual([false, true, true, true]);
});

test("marks canvas id segment as mono", () => {
  const segs = buildBreadcrumb({ pathname: "/canvas/cv_abc123", bySlug: {} });
  expect(segs.map((s) => Boolean(s.mono))).toEqual([false, true]);
});

test("feature route uses human names, not mono", () => {
  const segs = buildBreadcrumb({ pathname: "/projects/proj/features/feat", bySlug: {} });
  expect(segs.every((s) => !s.mono)).toBe(true);
});
