import { expect, test } from "bun:test";
import { buildBreadcrumb } from "../src/client/lib/breadcrumb.js";
import type { Project } from "../src/client/store/projects.js";
import { clientFeature, clientProject } from "./helpers/client-builders.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return clientProject("proj-id", {
    name: "Mandate", workingDir: "/tmp", isGit: true, tmuxSessionName: "md-mandate", createdAt: "x", updatedAt: "x",
    ...overrides
  });
}

/** The project's one feature, Voice agent. */
const voiceAgent = () => clientFeature("f1", {
  projectId: "proj-id", name: "Voice agent", tmuxWindowName: "voice-agent", createdAt: "x", updatedAt: "x", ownerThreadId: null
});

// A top-level page is one current crumb named as its nav item is; the bare
// root falls back to Home.
test.each([
  ["/", "Home"],
  ["/home", "Home"],
  ["/projects", "Projects"],
  ["/sessions", "Sessions"],
  ["/activity", "Activity"],
  ["/memory", "Memory"],
  ["/settings", "Settings"],
  ["/threads", "New thread"]
])("buildBreadcrumb: %s → [%s (current)]", (pathname, label) => {
  expect(buildBreadcrumb({ pathname, bySlug: {} })).toEqual([{ label, current: true }]);
});

test("buildBreadcrumb: a thread page is its title; an unknown thread reads Thread", () => {
  const threadTitle = (id: string) => (id === "thr_a" ? "Release project-1 3.21" : undefined);
  expect(buildBreadcrumb({ pathname: "/threads/thr_a", bySlug: {}, threadTitle }))
    .toEqual([{ label: "Release project-1 3.21", current: true }]);
  expect(buildBreadcrumb({ pathname: "/threads/thr_gone", bySlug: {}, threadTitle }))
    .toEqual([{ label: "Thread", current: true }]);
});

test("buildBreadcrumb: canvas detail has no link to a global gallery", () => {
  expect(buildBreadcrumb({ pathname: "/canvas/cnv_123", bySlug: {} }))
    .toEqual([
      { label: "Canvas" },
      { label: "cnv_123", current: true, mono: true }
    ]);
});

test("buildBreadcrumb: feature route resolves project + feature names", () => {
  const project = makeProject({
    tmuxSessionName: "md-mandate",
    name: "Mandate",
    features: [voiceAgent()]
  });
  expect(buildBreadcrumb({
    pathname: "/projects/md-mandate/features/voice-agent",
    bySlug: { "md-mandate": project }
  })).toEqual([
    { label: "Mandate", href: "/projects" },
    { label: "Voice agent", current: true }
  ]);
});

// Named Terminal, never by tmux's pane id (%37 says nothing to a person).
test("buildBreadcrumb: feature pane route ends in Terminal, with the feature linking back", () => {
  const project = makeProject({
    tmuxSessionName: "md-mandate",
    name: "Mandate",
    features: [voiceAgent()]
  });
  expect(buildBreadcrumb({
    pathname: "/projects/md-mandate/features/voice-agent/pane/p1",
    bySlug: { "md-mandate": project }
  })).toEqual([
    { label: "Mandate", href: "/projects" },
    { label: "Voice agent", href: "/projects/md-mandate/features/voice-agent?tab=terminal" },
    { label: "Terminal", current: true }
  ]);
});

test("buildBreadcrumb: session detail route", () => {
  expect(buildBreadcrumb({ pathname: "/sessions/sess-1", bySlug: {} }))
    .toEqual([
      { label: "sessions", href: "/sessions" },
      { label: "sess-1", current: true, mono: true }
    ]);
});

test("buildBreadcrumb: session pane route ends in Terminal, with the window linking back", () => {
  expect(buildBreadcrumb({
    pathname: "/sessions/sess-1/windows/dev/pane/%2537",
    bySlug: {}
  })).toEqual([
    { label: "sessions", href: "/sessions" },
    { label: "sess-1", href: "/sessions/sess-1", mono: true },
    { label: "dev", href: "/sessions/sess-1/windows/dev", mono: true },
    { label: "Terminal", current: true }
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

// A worker the projects don't hold read as the URL's slug ("does_not_exist")
// over "Worker not found"; it reads Worker, as an unknown thread
// reads Thread. A project's slug is its tmux session's name and stays.
test("buildBreadcrumb: an unknown project keeps its slug; an unknown worker reads Worker", () => {
  expect(buildBreadcrumb({
    pathname: "/projects/unknown/features/foo",
    bySlug: {}
  })).toEqual([
    { label: "unknown", href: "/projects" },
    { label: "Worker", current: true }
  ]);
  expect(buildBreadcrumb({
    pathname: "/projects/unknown/features/does_not_exist/pane/%251",
    bySlug: {}
  })).toEqual([
    { label: "unknown", href: "/projects" },
    { label: "Worker", href: "/projects/unknown/features/does_not_exist?tab=terminal" },
    { label: "Terminal", current: true }
  ]);
});

test("buildBreadcrumb: unknown route falls back to first segment", () => {
  expect(buildBreadcrumb({ pathname: "/something-unmapped", bySlug: {} }))
    .toEqual([{ label: "something-unmapped", current: true }]);
});
