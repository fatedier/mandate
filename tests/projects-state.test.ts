import { expect, test } from "bun:test";
import { computeProjectsState } from "../src/server/modules/projects/projects-state.js";
import type { ProjectRow } from "../src/server/modules/projects/projects-store.js";
import type { WorkerRow } from "../src/server/modules/workers/workers-store.js";

const baseProject: ProjectRow = {
  id: "p1", name: "P", workingDir: "/p",
  isGit: false, gitRemote: null,
  tmuxSessionName: "md-p", ownership: "app", sortOrder: 0,
  createdAt: "2026-05-02", updatedAt: "2026-05-02", archivedAt: null
};

const baseWorker: WorkerRow = {
  id: "f1", projectId: "p1", name: "F",
  mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
  tmuxWindowName: "f", ownership: "app", pinnedAt: null,
  createdAt: "2026-05-02", updatedAt: "2026-05-02", archivedAt: null, ownerThreadId: null
};

test("computeProjectsState: a project is alive while its tmux session is there", () => {
  const result = computeProjectsState([baseProject], [baseWorker], new Map([["md-p", ["md-p", "f"]]]));
  expect(result[0].tmuxStatus).toBe("alive");
  expect(result[0].workers.map((w) => w.id)).toEqual(["f1"]);
});

test("computeProjectsState: a project is gone when its session is missing", () => {
  const result = computeProjectsState([baseProject], [baseWorker], new Map<string, string[]>());
  expect(result[0].tmuxStatus).toBe("gone");
});

test("computeProjectsState: workers included only for matching project", () => {
  const otherWorker: WorkerRow = { ...baseWorker, id: "f2", projectId: "p2", tmuxWindowName: "f2" };
  const tmuxState = new Map([["md-p", ["md-p", "f"]]]);
  const result = computeProjectsState([baseProject], [baseWorker, otherWorker], tmuxState);
  expect(result.length).toBe(1);
  expect(result[0].workers.length).toBe(1);
  expect(result[0].workers[0].id).toBe("f1");
});
