import { expect, test } from "bun:test";
import { FeatureWindowStore } from "../src/server/modules/features/feature-window-store.js";
import { freshStoresEnv, seedProject } from "./helpers/fixtures.js";

const tempStore = () => freshStoresEnv("md-test-");

const seedP = (env: ReturnType<typeof tempStore>) =>
  seedProject(env.projects, { name: "Proj", workingDir: "/p", tmuxSessionName: "md-proj" });

test("FeaturesStore: insert + getById round-trip (shared-cwd)", () => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    const id = env.features.insert({
      projectId,
      name: "Feat A",
      mode: "shared-cwd",
      branch: null,
      worktreePath: null,
      tmuxWindowName: "feat_a",
      ownership: "app"
    });
    const row = env.features.getById(id);
    expect(row).toBeTruthy();
    expect(row!.projectId).toBe(projectId);
    expect(row!.name).toBe("Feat A");
    expect(row!.mode).toBe("shared-cwd");
    expect(row!.branch).toBe(null);
    expect(row!.worktreePath).toBe(null);
    expect(row!.tmuxWindowName).toBe("feat_a");
  } finally { env.cleanup(); }
});

test("FeaturesStore: listActiveByProject excludes archived", () => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    const id1 = env.features.insert({
      projectId, name: "A", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "a", ownership: "app"
    });
    const id2 = env.features.insert({
      projectId, name: "B", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "b", ownership: "app"
    });
    env.features.archive(id2);
    const active = env.features.listActiveByProject(projectId);
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(id1);
  } finally { env.cleanup(); }
});

test("FeaturesStore: insert rejects duplicate (projectId, name)", () => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    env.features.insert({
      projectId, name: "Dup", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "x", ownership: "app"
    });
    expect(() => env.features.insert({
      projectId, name: "Dup", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "y", ownership: "app"
    })).toThrow(/UNIQUE/i);
  } finally { env.cleanup(); }
});

test("FeaturesStore: insert rejects duplicate tmuxWindowName within project (active)", () => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    env.features.insert({
      projectId, name: "A", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "shared", ownership: "app"
    });
    expect(() => env.features.insert({
      projectId, name: "B", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "shared", ownership: "app"
    })).toThrow(/UNIQUE/i);
  } finally { env.cleanup(); }
});

test("FeaturesStore: archived feature frees tmuxWindowName for re-use", () => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    const id = env.features.insert({
      projectId, name: "A", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "shared", ownership: "app"
    });
    env.features.archive(id);
    // After archive, the same tmuxWindowName can be used again because the
    // unique index is partial (where archived_at is null).
    const id2 = env.features.insert({
      projectId, name: "B", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "shared", ownership: "app"
    });
    expect(id).not.toBe(id2);
  } finally { env.cleanup(); }
});

test("FeaturesStore: takenWindowNames returns active window names within project", () => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    env.features.insert({
      projectId, name: "A", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "a", ownership: "app"
    });
    env.features.insert({
      projectId, name: "B", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "b", ownership: "app"
    });
    const taken = env.features.takenWindowNames(projectId);
    expect([...taken].sort()).toEqual(["a", "b"]);
  } finally { env.cleanup(); }
});

test("FeaturesStore: archived feature frees name for reuse within project", () => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    const id1 = env.features.insert({
      projectId, name: "ReuseFeat", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "rf1", ownership: "app"
    });
    env.features.archive(id1);
    const id2 = env.features.insert({
      projectId, name: "ReuseFeat", mode: "shared-cwd",
      branch: null, worktreePath: null, tmuxWindowName: "rf2", ownership: "app"
    });
    expect(id1).not.toBe(id2);
  } finally { env.cleanup(); }
});

test("FeatureWindowStore: lists active tmux window keys across active projects", () => {
  const env = tempStore();
  try {
    const liveProjectId = seedProject(env.projects, {
      name: "Live",
      workingDir: "/live",
      tmuxSessionName: "md-live"
    });
    const archivedProjectId = seedProject(env.projects, {
      name: "Archived",
      workingDir: "/archived",
      tmuxSessionName: "md-archived"
    });
    const archivedFeatureId = env.features.insert({
      projectId: liveProjectId,
      name: "Archived feature",
      mode: "shared-cwd",
      branch: null,
      worktreePath: null,
      tmuxWindowName: "archived-feature",
      ownership: "app"
    });
    env.features.insert({
      projectId: liveProjectId,
      name: "Live feature",
      mode: "shared-cwd",
      branch: null,
      worktreePath: null,
      tmuxWindowName: "live-feature",
      ownership: "app"
    });
    env.features.insert({
      projectId: archivedProjectId,
      name: "Hidden feature",
      mode: "shared-cwd",
      branch: null,
      worktreePath: null,
      tmuxWindowName: "hidden-feature",
      ownership: "app"
    });

    env.features.archive(archivedFeatureId);
    env.projects.archive(archivedProjectId);

    const store = new FeatureWindowStore(env.store.db);
    expect([...store.listActiveWindowKeys()].sort()).toEqual(["md-live:live-feature"]);
  } finally { env.cleanup(); }
});
