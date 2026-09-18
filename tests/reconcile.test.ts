import { expect, test } from "bun:test";
import { reconcileProject, reconcileFeature, type ReconcileTmux } from "../src/server/modules/projects/project-reconcile.js";
import type { ProjectRow } from "../src/server/modules/projects/projects-store.js";
import type { FeatureRow } from "../src/server/modules/features/features-store.js";

function fakeTmux(initialSessions: Record<string, string[]> = {}): ReconcileTmux & { state: Record<string, string[]> } {
  const state: Record<string, string[]> = { ...initialSessions };
  return {
    state,
    hasSession: (name) => name in state,
    newSession: (name, _cwd) => { state[name] = [name]; },
    hasWindow: (session, win) => (state[session] ?? []).includes(win),
    newWindow: (session, win, _cwd) => {
      if (!(session in state)) throw new Error("session missing");
      state[session].push(win);
    }
  };
}

const baseProject: ProjectRow = {
  id: "p1", name: "P", workingDir: "/p",
  isGit: false, gitRemote: null,
  tmuxSessionName: "md-p", ownership: "app", sortOrder: 0,
  createdAt: "2026-05-01", updatedAt: "2026-05-01", archivedAt: null
};

const baseFeature: FeatureRow = {
  id: "f1", projectId: "p1", name: "F",
  mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
  tmuxWindowName: "f", ownership: "app", pinnedAt: null,
  createdAt: "2026-05-01", updatedAt: "2026-05-01", archivedAt: null
};

test("reconcileProject app-owned: missing session triggers create", () => {
  const tmux = fakeTmux();
  const r = reconcileProject(baseProject, [], tmux);
  expect(r.rebuilt).toBe(true);
  expect(tmux.state["md-p"]).toBeTruthy();
});

test("reconcileProject app-owned: existing session is no-op", () => {
  const tmux = fakeTmux({ "md-p": ["md-p"] });
  const r = reconcileProject(baseProject, [], tmux);
  expect(r.rebuilt).toBe(false);
});

test("reconcileProject app-owned: missing session also rebuilds active features", () => {
  const tmux = fakeTmux();
  const r = reconcileProject(baseProject, [baseFeature], tmux);
  expect(r.rebuilt).toBe(true);
  expect(tmux.state["md-p"].includes("f")).toBeTruthy();
});

test("reconcileProject adopted: missing session reports broken", () => {
  const tmux = fakeTmux();
  const adopted = { ...baseProject, ownership: "adopted" as const };
  const r = reconcileProject(adopted, [], tmux);
  expect(r.broken).toBe(true);
  expect(r.rebuilt).toBe(undefined);
});

test("reconcileProject adopted: existing session is no-op", () => {
  const tmux = fakeTmux({ "md-p": ["md-p"] });
  const adopted = { ...baseProject, ownership: "adopted" as const };
  const r = reconcileProject(adopted, [], tmux);
  expect(r.broken).toBe(undefined);
  expect(r.rebuilt).toBe(false);
});

test("reconcileFeature app-owned: missing window triggers create", () => {
  const tmux = fakeTmux({ "md-p": ["md-p"] });
  const r = reconcileFeature(baseFeature, baseProject, tmux);
  expect(r.rebuilt).toBe(true);
  expect(tmux.state["md-p"].includes("f")).toBeTruthy();
});

test("reconcileFeature app-owned: existing window is no-op", () => {
  const tmux = fakeTmux({ "md-p": ["md-p", "f"] });
  const r = reconcileFeature(baseFeature, baseProject, tmux);
  expect(r.rebuilt).toBe(false);
});

test("reconcileFeature adopted: missing window reports broken", () => {
  const tmux = fakeTmux({ "md-p": ["md-p"] });
  const adopted = { ...baseFeature, ownership: "adopted" as const };
  const r = reconcileFeature(adopted, baseProject, tmux);
  expect(r.broken).toBe(true);
});

test("reconcileFeature shared-cwd uses project workingDir for cwd", () => {
  const tmux = fakeTmux({ "md-p": ["md-p"] });
  let lastCwd = "";
  const wrapped: ReconcileTmux = {
    ...tmux,
    newWindow: (session, win, cwd) => { lastCwd = cwd; tmux.newWindow(session, win, cwd); }
  };
  reconcileFeature(baseFeature, baseProject, wrapped);
  expect(lastCwd).toBe("/p");
});
