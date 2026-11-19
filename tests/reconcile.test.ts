import { expect, test } from "bun:test";
import { reconcileProject, reconcileWorker, type ReconcileResult, type ReconcileTmux } from "../src/server/modules/projects/project-reconcile.js";
import type { ProjectRow } from "../src/server/modules/projects/projects-store.js";
import type { WorkerRow } from "../src/server/modules/workers/workers-store.js";

function fakeTmux(initialSessions: Record<string, string[]> = {}): ReconcileTmux & { state: Record<string, string[]> } {
  const state: Record<string, string[]> = { ...initialSessions };
  return {
    state,
    hasSession: async (name) => name in state,
    newSession: async (name, _cwd) => { state[name] = [name]; },
    hasWindow: async (session, win) => (state[session] ?? []).includes(win),
    newWindow: async (session, win, _cwd) => {
      if (!(session in state)) throw new Error("session missing");
      state[session].push(win);
      return `@${state[session].length}`;
    }
  };
}

const baseProject: ProjectRow = {
  id: "p1", name: "P", workingDir: "/p",
  isGit: false, gitRemote: null,
  tmuxSessionName: "md-p", ownership: "app", sortOrder: 0,
  createdAt: "2026-05-01", updatedAt: "2026-05-01", archivedAt: null
};

const baseWorker: WorkerRow = {
  id: "f1", projectId: "p1", name: "F",
  mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
  tmuxWindowName: "f", ownership: "app", pinnedAt: null,
  createdAt: "2026-05-01", updatedAt: "2026-05-01", archivedAt: null, ownerThreadId: null
};

type TmuxState = Record<string, string[]>;

interface ReconcileCase {
  name: string;
  ownership: "app" | "adopted";
  before: TmuxState;
  result: ReconcileResult;
  after: TmuxState;
}

// Each row compares the result's rebuilt / broken and the whole tmux state
// after the call: an adopted project or worker never gets a session or window.
const projectCases: (ReconcileCase & { workers: WorkerRow[] })[] = [
  { name: "app-owned: missing session triggers create", ownership: "app", workers: [], before: {},
    result: { rebuilt: true }, after: { "md-p": ["md-p"] } },
  { name: "app-owned: existing session is no-op", ownership: "app", workers: [], before: { "md-p": ["md-p"] },
    result: { rebuilt: false }, after: { "md-p": ["md-p"] } },
  { name: "app-owned: missing session also rebuilds active workers", ownership: "app", workers: [baseWorker], before: {},
    result: { rebuilt: true }, after: { "md-p": ["md-p", "f"] } },
  { name: "adopted: missing session reports broken", ownership: "adopted", workers: [], before: {},
    result: { broken: true }, after: {} },
  { name: "adopted: existing session is no-op", ownership: "adopted", workers: [], before: { "md-p": ["md-p"] },
    result: { rebuilt: false }, after: { "md-p": ["md-p"] } }
];

test.each(projectCases)("reconcileProject $name", async ({ ownership, workers, before, result, after }) => {
  const tmux = fakeTmux(before);
  const r = await reconcileProject({ ...baseProject, ownership }, workers, tmux);
  expect<ReconcileResult>({ rebuilt: r.rebuilt, broken: r.broken }).toEqual(result);
  expect(tmux.state).toEqual(after);
});

const workerCases: ReconcileCase[] = [
  { name: "app-owned: missing window triggers create", ownership: "app", before: { "md-p": ["md-p"] },
    result: { rebuilt: true }, after: { "md-p": ["md-p", "f"] } },
  { name: "app-owned: existing window is no-op", ownership: "app", before: { "md-p": ["md-p", "f"] },
    result: { rebuilt: false }, after: { "md-p": ["md-p", "f"] } },
  { name: "adopted: missing window reports broken", ownership: "adopted", before: { "md-p": ["md-p"] },
    result: { broken: true }, after: { "md-p": ["md-p"] } }
];

test.each(workerCases)("reconcileWorker $name", async ({ ownership, before, result, after }) => {
  const tmux = fakeTmux(before);
  const r = await reconcileWorker({ ...baseWorker, ownership }, baseProject, tmux);
  expect<ReconcileResult>({ rebuilt: r.rebuilt, broken: r.broken }).toEqual(result);
  expect(tmux.state).toEqual(after);
});

test("reconcileWorker shared-cwd uses project workingDir for cwd", async () => {
  const tmux = fakeTmux({ "md-p": ["md-p"] });
  let lastCwd = "";
  const wrapped: ReconcileTmux = {
    ...tmux,
    newWindow: async (session, win, cwd) => { lastCwd = cwd; return tmux.newWindow(session, win, cwd); }
  };
  await reconcileWorker(baseWorker, baseProject, wrapped);
  expect(lastCwd).toBe("/p");
});
