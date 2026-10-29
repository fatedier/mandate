import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { onCleanup } from "./helpers/cleanup.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

function newDb(): Database {
  const db = new Database(":memory:");
  // Initialize in dependency order: projects → features → agent
  // (mirrors registry.ts MODULES order; required for FK references)
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  return db;
}

test("schema: work_items has UNIQUE constraint on feature_id", () => {
  const db = newDb();
  const now = new Date().toISOString();
  // Seed project + feature to satisfy FK constraints
  db.prepare(
    `insert into projects (id, name, working_dir, tmux_session_name, ownership, created_at, updated_at)
     values ('proj-1', 'P', '/tmp', 'sess', 'app', ?, ?)`
  ).run(now, now);
  db.prepare(
    `insert into features (id, project_id, name, mode, tmux_window_name, ownership, created_at, updated_at)
     values ('feat-1', 'proj-1', 'F', 'shared-cwd', 'win', 'app', ?, ?)`
  ).run(now, now);
  db.prepare(
    `insert into work_items (id, feature_id, project_id, title,
       last_activity_at, created_at, updated_at)
     values (?, 'feat-1', 'proj-1', 'A', ?, ?, ?)`
  ).run("wi-1", now, now, now);
  expect(() => {
    db.prepare(
      `insert into work_items (id, feature_id, project_id, title,
         last_activity_at, created_at, updated_at)
       values (?, 'feat-1', 'proj-1', 'B', ?, ?, ?)`
    ).run("wi-2", now, now, now);
  }).toThrow(/UNIQUE constraint failed/);
});

/** A work item is made with its feature (features.insert), as in production. */
function newStore() {
  const env = freshStoresEnv("md-wi-");
  onCleanup(env.cleanup);
  const projectId = seedProject(env.projects);
  const store = new WorkItemStore(env.store.db);
  const itemFor = (name: string) => store.getByFeature(seedFeature(env.features, projectId, { name, tmuxWindowName: name }))!;
  return { store, itemFor, db: env.store.db };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("store: getByFeature returns the bound item", () => {
  const { store, itemFor } = newStore();
  const item = itemFor("Track auth flow");
  expect(store.getByFeature(item.featureId)).toMatchObject({ id: item.id, title: "Track auth flow" });
  expect(store.getByFeature("feat-nonexistent")).toBeNull();
});

test("store: touch advances last_activity_at and updated_at", async () => {
  const { store, itemFor } = newStore();
  const item = itemFor("T");
  await tick();
  const updated = store.touch(item.id);
  expect(updated).not.toBeNull();
  expect(updated!.lastActivityAt > item.lastActivityAt).toBe(true);
  expect(updated!.updatedAt > item.updatedAt).toBe(true);
});

test("store: listAttention returns the items whose last wake failed or stopped, the most recent failure first", () => {
  const { store, itemFor } = newStore();
  itemFor("Idle one");
  const older = itemFor("Failed first");
  const newer = itemFor("Stopped since");
  store.setFailure(older.featureId, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
  store.setFailure(newer.featureId, { at: "2026-09-27T13:00:00.000Z", message: "kept failing", kind: "stopped" });
  expect(store.listAttention().map((i) => [i.id, i.failedKind])).toEqual([[newer.id, "stopped"], [older.id, "error"]]);
});

test("store: listIdle returns recent items; a failure is not idle", () => {
  const { store, itemFor } = newStore();
  const item = itemFor("Idle item");
  expect(store.listIdle({ sinceMs: 60000 }).map((i) => i.id)).toEqual([item.id]);
  store.setFailure(item.featureId, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
  expect(store.listIdle({ sinceMs: 60000 })).toEqual([]);
});
