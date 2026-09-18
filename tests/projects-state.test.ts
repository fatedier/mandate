import { expect, test } from "bun:test";
import { computeProjectsState, tmuxStateKey } from "../src/server/modules/projects/projects-state.js";
import type { ProjectRow } from "../src/server/modules/projects/projects-store.js";
import type { FeatureRow } from "../src/server/modules/features/features-store.js";

const baseProject: ProjectRow = {
  id: "p1", name: "P", workingDir: "/p",
  isGit: false, gitRemote: null,
  tmuxSessionName: "md-p", ownership: "app", sortOrder: 0,
  createdAt: "2026-05-02", updatedAt: "2026-05-02", archivedAt: null
};

const baseFeature: FeatureRow = {
  id: "f1", projectId: "p1", name: "F",
  mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null,
  tmuxWindowName: "f", ownership: "app", pinnedAt: null,
  createdAt: "2026-05-02", updatedAt: "2026-05-02", archivedAt: null
};

test("computeProjectsState: project tmuxAlive=true when session present", () => {
  const tmuxState = new Map([[tmuxStateKey("md-p"), ["md-p", "f"]]]);
  const result = computeProjectsState([baseProject], [baseFeature], tmuxState);
  expect(result[0].tmuxAlive).toBe(true);
  expect(result[0].features[0].tmuxAlive).toBe(true);
});

test("computeProjectsState: project tmuxAlive=false when session missing", () => {
  const tmuxState = new Map<string, string[]>();
  const result = computeProjectsState([baseProject], [baseFeature], tmuxState);
  expect(result[0].tmuxAlive).toBe(false);
  expect(result[0].tmuxStatus).toBe("gone");
  expect(result[0].features[0].tmuxAlive).toBe(false);
  expect(result[0].features[0].tmuxStatus).toBe("gone");
});

test("computeProjectsState: feature tmuxAlive=false when session present but window missing", () => {
  const tmuxState = new Map([[tmuxStateKey("md-p"), ["md-p"]]]);
  const result = computeProjectsState([baseProject], [baseFeature], tmuxState);
  expect(result[0].tmuxAlive).toBe(true);
  expect(result[0].features[0].tmuxAlive).toBe(false);
});

test("computeProjectsState: features included only for matching project", () => {
  const otherFeature: FeatureRow = { ...baseFeature, id: "f2", projectId: "p2", tmuxWindowName: "f2" };
  const tmuxState = new Map([[tmuxStateKey("md-p"), ["md-p", "f"]]]);
  const result = computeProjectsState([baseProject], [baseFeature, otherFeature], tmuxState);
  expect(result.length).toBe(1);
  expect(result[0].features.length).toBe(1);
  expect(result[0].features[0].id).toBe("f1");
});
