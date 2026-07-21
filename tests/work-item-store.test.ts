import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";

function newDb(): Database {
  const db = new Database(":memory:");
  // Initialize in dependency order: projects → features → agent
  // (mirrors registry.ts MODULES order; required for FK references)
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  return db;
}

test("schema: work_items table exists with expected columns", () => {
  const db = newDb();
  const cols = db.prepare("pragma table_info(work_items)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name).sort();
  expect(names).toContain("needs_user");
  expect(names).toContain("feature_id");
  expect(names).toContain("project_id");
  expect(names).toContain("title");
  expect(names).toContain("summary");
  expect(names).toContain("phase");
  expect(names).toContain("canvas_id");
  expect(names).not.toContain("body");
  expect(names).not.toContain("status");
  expect(names).not.toContain("urgency");
  expect(names).not.toContain("state");
  expect(names).not.toContain("archived_at");
});

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
    `insert into work_items (id, feature_id, project_id, title, needs_user, phase,
       last_activity_at, created_at, updated_at)
     values (?, 'feat-1', 'proj-1', 'A', null, 'design', ?, ?, ?)`
  ).run("wi-1", now, now, now);
  expect(() => {
    db.prepare(
      `insert into work_items (id, feature_id, project_id, title, needs_user, phase,
         last_activity_at, created_at, updated_at)
       values (?, 'feat-1', 'proj-1', 'B', null, 'design', ?, ?, ?)`
    ).run("wi-2", now, now, now);
  }).toThrow();
});

test("schema: agent_mailbox has event_kind column", () => {
  const db = newDb();
  const cols = db.prepare("pragma table_info(agent_mailbox)").all() as Array<{ name: string; notnull: number }>;
  const eventKind = cols.find((c) => c.name === "event_kind");
  expect(eventKind).toBeDefined();
  expect(eventKind!.notnull).toBe(1);
});

function newStore(): { store: WorkItemStore; db: Database } {
  const db = newDb();
  const now = new Date().toISOString();
  // Seed a minimal project + feature to satisfy FK constraints
  db.prepare(
    `insert into projects (id, name, working_dir, tmux_session_name, ownership, created_at, updated_at)
     values ('proj-1', 'Test Project', '/tmp', 'sess-1', 'app', ?, ?)`
  ).run(now, now);
  db.prepare(
    `insert into features (id, project_id, name, mode, tmux_window_name, ownership, created_at, updated_at)
     values ('feat-1', 'proj-1', 'Test Feature', 'shared-cwd', 'win-1', 'app', ?, ?)`
  ).run(now, now);
  return { store: new WorkItemStore(db), db };
}

test("store: create binds to feature_id with defaults", () => {
  const { store } = newStore();
  const item = store.create({
    featureId: "feat-1",
    projectId: "proj-1",
    title: "Login"
  });
  expect(item.id).toMatch(/^wi_/);
  expect(item.featureId).toBe("feat-1");
  expect(item.projectId).toBe("proj-1");
  expect(item.needsUser).toBeNull();
  expect(item.phase).toBe("design");
  expect(item.phaseDetail).toBeNull();
  expect(item.summary).toBeNull();
  expect(item.lastActivityAt).toBeTruthy();
});

test("store: getByFeature returns the bound item", () => {
  const { store } = newStore();
  const item = store.create({
    featureId: "feat-1",
    projectId: "proj-1",
    title: "Track auth flow"
  });
  const fetched = store.getByFeature("feat-1");
  expect(fetched).not.toBeNull();
  expect(fetched!.id).toBe(item.id);
  expect(fetched!.title).toBe("Track auth flow");
  expect(store.getByFeature("feat-nonexistent")).toBeNull();
});

test("store: update advances last_activity_at and updated_at", async () => {
  const { store } = newStore();
  const item = store.create({ featureId: "feat-1", projectId: "proj-1", title: "T" });
  const t0LastActivity = item.lastActivityAt;
  const t0Updated = item.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const updated = store.update(item.id, { phase: "working", phaseDetail: "started wiring" });
  expect(updated).not.toBeNull();
  expect(updated!.phase).toBe("working");
  expect(updated!.phaseDetail).toBe("started wiring");
  expect(updated!.lastActivityAt > t0LastActivity).toBe(true);
  expect(updated!.updatedAt > t0Updated).toBe(true);
});

test("store: update needsUser=review sets correct value", () => {
  const { store } = newStore();
  const item = store.create({ featureId: "feat-1", projectId: "proj-1", title: "Review me" });
  expect(item.needsUser).toBeNull();
  const updated = store.update(item.id, { needsUser: "review" });
  expect(updated).not.toBeNull();
  expect(updated!.needsUser).toBe("review");
});

test("store: update needsUser=input sets correct value", () => {
  const { store } = newStore();
  const item = store.create({ featureId: "feat-1", projectId: "proj-1", title: "Input needed" });
  expect(item.needsUser).toBeNull();
  const updated = store.update(item.id, { needsUser: "input" });
  expect(updated).not.toBeNull();
  expect(updated!.needsUser).toBe("input");
});

test("store: update needsUser=null clears the field", () => {
  const { store } = newStore();
  const item = store.create({ featureId: "feat-1", projectId: "proj-1", title: "Clear flag", needsUser: "review" });
  const cleared = store.update(item.id, { needsUser: null });
  expect(cleared).not.toBeNull();
  expect(cleared!.needsUser).toBeNull();
});

test("store: listAttention returns only items with needsUser set, sorted input before review", async () => {
  const { store, db } = newStore();
  const now = new Date().toISOString();
  // Seed a second feature for the second work item
  db.prepare(
    `insert into features (id, project_id, name, mode, tmux_window_name, ownership, created_at, updated_at)
     values ('feat-2', 'proj-1', 'Feature 2', 'shared-cwd', 'win-2', 'app', ?, ?)`
  ).run(now, now);

  // Create an idle item (needsUser=null) — should be excluded
  store.create({ featureId: "feat-1", projectId: "proj-1", title: "Idle one" });
  await new Promise((r) => setTimeout(r, 5));

  // Create review item on feat-2
  const ackItem = store.create({ featureId: "feat-2", projectId: "proj-1", title: "Review me", needsUser: "review" });

  // Update feat-1 item to needsUser=input
  const feat1Item = store.getByFeature("feat-1")!;
  store.update(feat1Item.id, { needsUser: "input" });

  const attention = store.listAttention();
  // input comes before review; idle excluded
  expect(attention.length).toBe(2);
  expect(attention[0].needsUser).toBe("input");
  expect(attention[1].needsUser).toBe("review");
  expect(attention[1].id).toBe(ackItem.id);
});

test("store: listAttention excludes items with needsUser=null", async () => {
  const { store, db } = newStore();
  const now = new Date().toISOString();
  db.prepare(
    `insert into features (id, project_id, name, mode, tmux_window_name, ownership, created_at, updated_at)
     values ('feat-2', 'proj-1', 'Feature 2', 'shared-cwd', 'win-2', 'app', ?, ?)`
  ).run(now, now);

  const item1 = store.create({ featureId: "feat-1", projectId: "proj-1", title: "Idle 1", needsUser: "input" });
  const item2 = store.create({ featureId: "feat-2", projectId: "proj-1", title: "Idle 2", needsUser: "review" });

  // Clear needsUser — should be excluded from listAttention
  store.update(item1.id, { needsUser: null });
  store.update(item2.id, { needsUser: null });

  const attention = store.listAttention();
  expect(attention).toHaveLength(0);
});

test("store: listIdle returns recent idle items (needsUser=null)", async () => {
  const { store } = newStore();
  // Default needsUser=null → should appear in idle list
  store.create({ featureId: "feat-1", projectId: "proj-1", title: "Idle item" });
  const idleBefore = store.listIdle({ sinceMs: 60000 });
  expect(idleBefore.length).toBe(1);
  expect(idleBefore[0].needsUser).toBeNull();

  // Update to needsUser=input → no longer idle → not in idle list
  const item = store.getByFeature("feat-1")!;
  store.update(item.id, { needsUser: "input" });
  const idleAfter = store.listIdle({ sinceMs: 60000 });
  expect(idleAfter.length).toBe(0);
});
