import { expect, test } from "bun:test";
import { buildBreadcrumb } from "../src/client/lib/breadcrumb.js";
import type { Project } from "../src/client/store/projects.js";
import { clientWorker, clientProject } from "./helpers/client-builders.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return clientProject("proj-id", {
    name: "Mandate", workingDir: "/tmp", isGit: true, tmuxSessionName: "md-mandate", createdAt: "x", updatedAt: "x",
    ...overrides
  });
}

/** The project's one worker, Voice agent. */
const voiceAgent = () => clientWorker("f1", {
  projectId: "proj-id", name: "Voice agent", tmuxWindowName: "voice-agent", createdAt: "x", updatedAt: "x", ownerThreadId: null
});

// A top-level page is one current crumb named as its nav item is; the bare
// root falls back to Home.
test.each([
  ["/", "Home"],
  ["/home", "Home"],
  ["/projects", "Projects"],
  ["/terminals", "Terminals"],
  ["/activity", "Activity"],
  ["/memory", "Memory"],
  ["/settings", "Settings"],
  ["/threads", "New thread"]
])("buildBreadcrumb: %s → [%s (current)]", (pathname, label) => {
  expect(buildBreadcrumb({ pathname, bySlug: {} })).toEqual([{ label }]);
});

test("buildBreadcrumb: a thread page is its title; an unknown thread reads Thread", () => {
  const threadTitle = (id: string) => (id === "thr_a" ? "Release project-1 3.21" : undefined);
  expect(buildBreadcrumb({ pathname: "/threads/thr_a", bySlug: {}, threadTitle }))
    .toEqual([{ label: "Release project-1 3.21" }]);
  expect(buildBreadcrumb({ pathname: "/threads/thr_gone", bySlug: {}, threadTitle }))
    .toEqual([{ label: "Thread" }]);
});

test("buildBreadcrumb: canvas detail has no link to a global gallery", () => {
  expect(buildBreadcrumb({ pathname: "/canvas/cnv_123", bySlug: {} }))
    .toEqual([
      { label: "Canvas" },
      { label: "cnv_123", mono: true }
    ]);
});


// Named Terminal, never by tmux's pane id (%37 says nothing to a person).
test("buildBreadcrumb: worker pane route ends in Terminal, with the worker linking back to its Terminal tab in its thread", () => {
  const project = makeProject({
    tmuxSessionName: "md-mandate",
    name: "Mandate",
    workers: [{ ...voiceAgent(), ownerThreadId: "thr_v" }]
  });
  expect(buildBreadcrumb({
    pathname: "/projects/md-mandate/workers/voice-agent/pane/p1",
    bySlug: { "md-mandate": project }
  })).toEqual([
    { label: "Mandate", href: "/projects/md-mandate" },
    { label: "Voice agent", href: "/threads/thr_v?worker=f1&tab=terminal" },
    { label: "Terminal" }
  ]);
});

test("buildBreadcrumb: a project's page reads Projects, then its name; an unknown one its slug", () => {
  const project = makeProject();
  expect(buildBreadcrumb({ pathname: "/projects/md-mandate", bySlug: { "md-mandate": project } }))
    .toEqual([{ label: "Projects", href: "/projects" }, { label: "Mandate" }]);
  expect(buildBreadcrumb({ pathname: "/projects/md-gone", bySlug: {} }))
    .toEqual([{ label: "Projects", href: "/projects" }, { label: "md-gone" }]);
});

test("buildBreadcrumb: a terminal and a window are under Terminals", () => {
  expect(buildBreadcrumb({ pathname: "/terminals/pane/%2537", bySlug: {} }))
    .toEqual([{ label: "Terminals", href: "/terminals" }, { label: "Terminal" }]);
  expect(buildBreadcrumb({ pathname: "/terminals/window/%401", bySlug: {} }))
    .toEqual([{ label: "Terminals", href: "/terminals" }, { label: "Window" }]);
});

// A worker the projects don't hold reads Worker, as an unknown thread reads
// Thread. A project's slug is its tmux session's name and stays.
test("buildBreadcrumb: an unknown project keeps its slug; an unknown worker reads Worker", () => {
  expect(buildBreadcrumb({
    pathname: "/projects/unknown/workers/does_not_exist/pane/%251",
    bySlug: {}
  })).toEqual([
    { label: "unknown", href: "/projects" },
    { label: "Worker", href: "/projects" },
    { label: "Terminal" }
  ]);
});

test("buildBreadcrumb: unknown route falls back to first segment", () => {
  expect(buildBreadcrumb({ pathname: "/something-unmapped", bySlug: {} }))
    .toEqual([{ label: "something-unmapped" }]);
});
