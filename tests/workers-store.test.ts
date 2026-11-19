import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeWorkersSchema } from "../src/server/modules/workers/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { freshStoresEnv, seedProject } from "./helpers/fixtures.js";

const tempStore = () => freshStoresEnv("md-test-");

const seedP = (env: ReturnType<typeof tempStore>) =>
  seedProject(env.projects, { name: "Proj", workingDir: "/p", tmuxSessionName: "md-proj" });

test("WorkersStore: insert + getById round-trip (shared-cwd)", () => {
  const env = tempStore();
  const projectId = seedP(env);
  const id = env.workers.insert({
    projectId,
    name: "Worker A",
    mode: "shared-cwd",
    branch: null,
    worktreePath: null,
    tmuxWindowName: "wkr_a",
    ownership: "app"
  });
  const row = env.workers.getById(id);
  expect(row).toBeTruthy();
  expect(row!.projectId).toBe(projectId);
  expect(row!.name).toBe("Worker A");
  expect(row!.mode).toBe("shared-cwd");
  expect(row!.branch).toBe(null);
  expect(row!.worktreePath).toBe(null);
  expect(row!.tmuxWindowName).toBe("wkr_a");
});

test("WorkersStore: listActiveByProject excludes archived", () => {
  const env = tempStore();
  const projectId = seedP(env);
  const id1 = env.workers.insert({
    projectId, name: "A", mode: "shared-cwd",
    branch: null, worktreePath: null, tmuxWindowName: "a", ownership: "app"
  });
  const id2 = env.workers.insert({
    projectId, name: "B", mode: "shared-cwd",
    branch: null, worktreePath: null, tmuxWindowName: "b", ownership: "app"
  });
  env.workers.archive(id2);
  const active = env.workers.listActiveByProject(projectId);
  expect(active.length).toBe(1);
  expect(active[0].id).toBe(id1);
});

interface WorkerNames { name: string; tmuxWindowName: string }

// Two workers of one project that clash on one field. While the first is
// active the second is refused; once it is archived the second goes in.
const clashes: { rejects: string; frees: string; first: WorkerNames; second: WorkerNames }[] = [
  {
    rejects: "insert rejects duplicate (projectId, name)",
    frees: "archived worker frees name for reuse within project",
    first: { name: "Dup", tmuxWindowName: "x" }, second: { name: "Dup", tmuxWindowName: "y" }
  },
  {
    rejects: "insert rejects duplicate tmuxWindowName within project (active)",
    frees: "archived worker frees tmuxWindowName for re-use",
    first: { name: "A", tmuxWindowName: "shared" }, second: { name: "B", tmuxWindowName: "shared" }
  }
];

const insertWorker = (env: ReturnType<typeof tempStore>, projectId: string, names: WorkerNames) =>
  env.workers.insert({ projectId, ...names, mode: "shared-cwd", branch: null, worktreePath: null, ownership: "app" });

test.each(clashes)("WorkersStore: $rejects", ({ first, second }) => {
  const env = tempStore();
  const projectId = seedP(env);
  insertWorker(env, projectId, first);
  expect(() => insertWorker(env, projectId, second)).toThrow(/UNIQUE/i);
});

// After archive, the same name or tmuxWindowName can be used again because
// the unique indexes are partial (where archived_at is null).
test.each(clashes)("WorkersStore: $frees", ({ first, second }) => {
  const env = tempStore();
  const projectId = seedP(env);
  const id = insertWorker(env, projectId, first);
  env.workers.archive(id);
  const id2 = insertWorker(env, projectId, second);
  expect(id).not.toBe(id2);
});

test("WorkersStore: takenWindowNames returns active window names within project", () => {
  const env = tempStore();
  const projectId = seedP(env);
  env.workers.insert({
    projectId, name: "A", mode: "shared-cwd",
    branch: null, worktreePath: null, tmuxWindowName: "a", ownership: "app"
  });
  env.workers.insert({
    projectId, name: "B", mode: "shared-cwd",
    branch: null, worktreePath: null, tmuxWindowName: "b", ownership: "app"
  });
  const taken = env.workers.takenWindowNames(projectId);
  expect([...taken].sort()).toEqual(["a", "b"]);
});

// The bound work item and archiving, on an in-memory database.

function newDb(): Database {
  const db = new Database(":memory:");
  // Initialize in dependency order: projects → workers → agent (FK order)
  initializeProjectsSchema(db);
  initializeWorkersSchema(db);
  initializeAgentSchema(db);
  return db;
}

function seedTestProject(db: Database): string {
  return seedProject(new ProjectsStore(db), { name: "test-project", workingDir: "/tmp/test-project", tmuxSessionName: "test-project" });
}

test("workers.insert creates a bound work_item with defaults", () => {
  const db = newDb();
  const projectId = seedTestProject(db);
  const workers = new WorkersStore(db);
  const workItems = new WorkItemStore(db);

  const workerId = workers.insert({
    projectId,
    name: "login",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "login",
    ownership: "app"
  });

  const item = workItems.getByWorker(workerId);
  expect(item).not.toBeNull();
  expect(item!.workerId).toBe(workerId);
  expect(item!.projectId).toBe(projectId);
  expect(item!.title).toBe("login");
});

test("workers.insert rollback: if work_item insert fails, no worker row remains", () => {
  // The workers table has a unique index on (project_id, name) where archived_at is null
  // (idx_workers_active_name). We can't easily trigger a work_items failure without
  // monkey-patching. Instead, we verify atomicity by confirming the transaction leaves
  // no orphaned worker when the work_item insert fails due to duplicate worker_id
  // (work_items.worker_id is UNIQUE). We insert a worker+work_item manually, then
  // attempt to insert a second worker with a forced duplicate work_item — but since
  // the work_item insert uses a fresh ID each time, a more reliable trigger is:
  // drop the work_items table to force a "no such table" error after the worker insert.
  const db = newDb();
  const projectId = seedTestProject(db);
  const workers = new WorkersStore(db);

  // Drop work_items so the second insert inside the transaction will fail
  db.prepare("drop table if exists work_items").run();

  expect(() => {
    workers.insert({
      projectId,
      name: "broken-worker",
      mode: "shared-cwd",
      branch: null,
      baseRef: null,
      worktreePath: null,
      tmuxWindowName: "broken",
      ownership: "app"
    });
  }).toThrow();

  // Rollback: the workers table should be empty — no orphaned row
  const count = (db.prepare("select count(*) as n from workers").get() as { n: number }).n;
  expect(count).toBe(0);
});

test("store: archive clears pinned_at", () => {
  const db = newDb();
  const projectId = seedTestProject(db);
  const workers = new WorkersStore(db);
  const id = workers.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  workers.setPinned(id, true);
  workers.archive(id);
  expect(workers.getById(id)!.pinnedAt).toBeNull();
});

test("workers.archive preserves already-archived worker archivedAt (idempotent)", () => {
  const db = newDb();
  const projectId = seedTestProject(db);
  const workers = new WorkersStore(db);
  const workerId = workers.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  workers.archive(workerId);
  // Archived long ago: in one millisecond a rewrite would look the same.
  const archivedAt = "2020-01-01T00:00:00.000Z";
  db.prepare("update workers set archived_at = ? where id = ?").run(archivedAt, workerId);
  workers.archive(workerId);
  // Second archive call preserves the original timestamp (idempotent)
  expect(workers.getById(workerId)!.archivedAt).toBe(archivedAt);
});

test("workers.archiveByProjectId archives all workers under that project", () => {
  const db = newDb();
  const projectId = seedTestProject(db);
  const workers = new WorkersStore(db);
  const f1 = workers.insert({
    projectId, name: "a", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w1", ownership: "app"
  });
  const f2 = workers.insert({
    projectId, name: "b", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w2", ownership: "app"
  });
  workers.archiveByProjectId(projectId);
  expect(workers.getById(f1)!.archivedAt).not.toBeNull();
  expect(workers.getById(f2)!.archivedAt).not.toBeNull();
});

// A task's automatic labels follow its threads' workers, so a worker moving
// thread changes two tasks' labels.
test("WorkersStore: a worker moving to another thread is told, with where it came from; staying put is not", () => {
  const env = tempStore();
  const projectId = seedP(env);
  const id = env.workers.insert({
    projectId, name: "Worker A", mode: "shared-cwd", branch: null, worktreePath: null,
    tmuxWindowName: "wkr_move", ownership: "app", ownerThreadId: "thr_a"
  });
  const moves: string[] = [];
  const stop = env.workers.onOwnerChange((m) => { moves.push(`${m.workerId === id}:${m.from}>${m.to}`); });
  env.workers.setOwner(id, "thr_b");
  env.workers.setOwner(id, "thr_b");
  env.workers.archive(id);
  env.workers.restore({ id, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null, tmuxWindowName: "wkr_move", ownerThreadId: "thr_c" });
  env.workers.archive(id);
  env.workers.restore({ id, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null, tmuxWindowName: "wkr_move" });
  // A restore undone puts the worker back with the thread it had.
  env.workers.archive(id);
  const archived = env.workers.getById(id)!;
  env.workers.restore({ id, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null, tmuxWindowName: "wkr_move", ownerThreadId: "thr_d" });
  env.workers.undoRestore(archived);
  expect(moves).toEqual(["true:thr_a>thr_b", "true:thr_b>thr_c", "true:thr_c>thr_d", "true:thr_d>thr_c"]);
  stop();
  env.workers.setOwner(id, "thr_e");
  expect(moves.length).toBe(4);
  env.cleanup();
});

// A worker made for a thread joins it as a move does, while that thread's
// turn may still be running.
test("WorkersStore: a worker made for a thread is told as joining it; one made for none is not", () => {
  const env = tempStore();
  const projectId = seedP(env);
  const moves: string[] = [];
  env.workers.onOwnerChange((m) => { moves.push(`${m.from}>${m.to}`); });
  const base = { projectId, mode: "shared-cwd" as const, branch: null, worktreePath: null, ownership: "app" as const };
  env.workers.insert({ ...base, name: "Owned", tmuxWindowName: "wkr_owned", ownerThreadId: "thr_a" });
  env.workers.insert({ ...base, name: "Unowned", tmuxWindowName: "wkr_unowned" });
  expect(moves).toEqual(["null>thr_a"]);
  env.cleanup();
});
