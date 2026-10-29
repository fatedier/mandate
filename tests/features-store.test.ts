import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
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

interface FeatureNames { name: string; tmuxWindowName: string }

// Two features of one project that clash on one field. While the first is
// active the second is refused; once it is archived the second goes in.
const clashes: { rejects: string; frees: string; first: FeatureNames; second: FeatureNames }[] = [
  {
    rejects: "insert rejects duplicate (projectId, name)",
    frees: "archived feature frees name for reuse within project",
    first: { name: "Dup", tmuxWindowName: "x" }, second: { name: "Dup", tmuxWindowName: "y" }
  },
  {
    rejects: "insert rejects duplicate tmuxWindowName within project (active)",
    frees: "archived feature frees tmuxWindowName for re-use",
    first: { name: "A", tmuxWindowName: "shared" }, second: { name: "B", tmuxWindowName: "shared" }
  }
];

const insertFeature = (env: ReturnType<typeof tempStore>, projectId: string, names: FeatureNames) =>
  env.features.insert({ projectId, ...names, mode: "shared-cwd", branch: null, worktreePath: null, ownership: "app" });

test.each(clashes)("FeaturesStore: $rejects", ({ first, second }) => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    insertFeature(env, projectId, first);
    expect(() => insertFeature(env, projectId, second)).toThrow(/UNIQUE/i);
  } finally { env.cleanup(); }
});

// After archive, the same name or tmuxWindowName can be used again because
// the unique indexes are partial (where archived_at is null).
test.each(clashes)("FeaturesStore: $frees", ({ first, second }) => {
  const env = tempStore();
  try {
    const projectId = seedP(env);
    const id = insertFeature(env, projectId, first);
    env.features.archive(id);
    const id2 = insertFeature(env, projectId, second);
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

// The bound work item and archiving, on an in-memory database.

function newDb(): Database {
  const db = new Database(":memory:");
  // Initialize in dependency order: projects → features → agent (FK order)
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  return db;
}

function seedTestProject(db: Database): string {
  return seedProject(new ProjectsStore(db), { name: "test-project", workingDir: "/tmp/test-project", tmuxSessionName: "test-project" });
}

test("features.insert creates a bound work_item with defaults", () => {
  const db = newDb();
  const projectId = seedTestProject(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);

  const featureId = features.insert({
    projectId,
    name: "login",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "login",
    ownership: "app"
  });

  const item = workItems.getByFeature(featureId);
  expect(item).not.toBeNull();
  expect(item!.featureId).toBe(featureId);
  expect(item!.projectId).toBe(projectId);
  expect(item!.title).toBe("login");
});

test("features.insert rollback: if work_item insert fails, no feature row remains", () => {
  // The features table has a unique index on (project_id, name) where archived_at is null
  // (idx_features_active_name). We can't easily trigger a work_items failure without
  // monkey-patching. Instead, we verify atomicity by confirming the transaction leaves
  // no orphaned feature when the work_item insert fails due to duplicate feature_id
  // (work_items.feature_id is UNIQUE). We insert a feature+work_item manually, then
  // attempt to insert a second feature with a forced duplicate work_item — but since
  // the work_item insert uses a fresh ID each time, a more reliable trigger is:
  // drop the work_items table to force a "no such table" error after the feature insert.
  const db = newDb();
  const projectId = seedTestProject(db);
  const features = new FeaturesStore(db);

  // Drop work_items so the second insert inside the transaction will fail
  db.prepare("drop table if exists work_items").run();

  expect(() => {
    features.insert({
      projectId,
      name: "broken-feature",
      mode: "shared-cwd",
      branch: null,
      baseRef: null,
      worktreePath: null,
      tmuxWindowName: "broken",
      ownership: "app"
    });
  }).toThrow();

  // Rollback: the features table should be empty — no orphaned row
  const count = (db.prepare("select count(*) as n from features").get() as { n: number }).n;
  expect(count).toBe(0);
});

test("store: archive clears pinned_at", () => {
  const db = newDb();
  const projectId = seedTestProject(db);
  const features = new FeaturesStore(db);
  const id = features.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  features.setPinned(id, true);
  features.archive(id);
  expect(features.getById(id)!.pinnedAt).toBeNull();
});

test("features.archive preserves already-archived feature archivedAt (idempotent)", () => {
  const db = newDb();
  const projectId = seedTestProject(db);
  const features = new FeaturesStore(db);
  const featureId = features.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  features.archive(featureId);
  // Archived long ago: in one millisecond a rewrite would look the same.
  const archivedAt = "2020-01-01T00:00:00.000Z";
  db.prepare("update features set archived_at = ? where id = ?").run(archivedAt, featureId);
  features.archive(featureId);
  // Second archive call preserves the original timestamp (idempotent)
  expect(features.getById(featureId)!.archivedAt).toBe(archivedAt);
});

test("features.archiveByProjectId archives all features under that project", () => {
  const db = newDb();
  const projectId = seedTestProject(db);
  const features = new FeaturesStore(db);
  const f1 = features.insert({
    projectId, name: "a", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w1", ownership: "app"
  });
  const f2 = features.insert({
    projectId, name: "b", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w2", ownership: "app"
  });
  features.archiveByProjectId(projectId);
  expect(features.getById(f1)!.archivedAt).not.toBeNull();
  expect(features.getById(f2)!.archivedAt).not.toBeNull();
});
