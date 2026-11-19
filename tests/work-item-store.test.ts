import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { initializeWorkersSchema } from "../src/server/modules/workers/schema.js";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializePlansSchema } from "../src/server/modules/plans/schema.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";

function newDb(): Database {
  const db = new Database(":memory:");
  // Initialize in dependency order: projects → workers → agent
  // (mirrors registry.ts MODULES order; required for FK references)
  initializeProjectsSchema(db);
  initializeWorkersSchema(db);
  initializeAgentSchema(db);
  return db;
}

test("schema: work_items has UNIQUE constraint on worker_id", () => {
  const db = newDb();
  const now = new Date().toISOString();
  // Seed project + worker to satisfy FK constraints
  db.prepare(
    `insert into projects (id, name, working_dir, tmux_session_name, ownership, created_at, updated_at)
     values ('proj-1', 'P', '/tmp', 'sess', 'app', ?, ?)`
  ).run(now, now);
  db.prepare(
    `insert into workers (id, project_id, name, mode, tmux_window_name, ownership, created_at, updated_at)
     values ('wkr-1', 'proj-1', 'F', 'shared-cwd', 'win', 'app', ?, ?)`
  ).run(now, now);
  db.prepare(
    `insert into work_items (id, worker_id, project_id, title,
       last_activity_at, created_at, updated_at)
     values (?, 'wkr-1', 'proj-1', 'A', ?, ?, ?)`
  ).run("wi-1", now, now, now);
  expect(() => {
    db.prepare(
      `insert into work_items (id, worker_id, project_id, title,
         last_activity_at, created_at, updated_at)
       values (?, 'wkr-1', 'proj-1', 'B', ?, ?, ?)`
    ).run("wi-2", now, now, now);
  }).toThrow(/UNIQUE constraint failed/);
});

/** A work item is made with its worker (workers.insert), as in production. */
function newStore() {
  const env = freshStoresEnv("md-wi-");
  const projectId = seedProject(env.projects);
  const store = new WorkItemStore(env.store.db);
  const itemFor = (name: string) => store.getByWorker(seedWorker(env.workers, projectId, { name, tmuxWindowName: name }))!;
  return { store, itemFor, db: env.store.db };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("store: getByWorker returns the bound item", () => {
  const { store, itemFor } = newStore();
  const item = itemFor("Track auth flow");
  expect(store.getByWorker(item.workerId)).toMatchObject({ id: item.id, title: "Track auth flow" });
  expect(store.getByWorker("wkr-nonexistent")).toBeNull();
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
  store.setFailure(older.workerId, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
  store.setFailure(newer.workerId, { at: "2026-09-27T13:00:00.000Z", message: "kept failing", kind: "stopped" });
  expect(store.listAttention().map((i) => [i.id, i.failedKind])).toEqual([[newer.id, "stopped"], [older.id, "error"]]);
});

test("store: listIdle returns recent items; a failure is not idle", () => {
  const { store, itemFor } = newStore();
  const item = itemFor("Idle item");
  expect(store.listIdle().map((i) => i.id)).toEqual([item.id]);
  store.setFailure(item.workerId, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
  expect(store.listIdle()).toEqual([]);
});

/**
 * Stalled means: not finished (a plan step still pending or in progress),
 * nobody waiting on it, and nothing that will make it move. The four "nothing will move it" clauses are the complete set of wake
 * sources other than the user, so each one gets a test that it alone is enough
 * to keep an item out.
 */

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeWorkersSchema(db);
  initializePlansSchema(db);
  initializeAgentSchema(db);
  const plans = new PlanStore(db);
  const projects = new ProjectsStore(db);
  const workers = new WorkersStore(db);
  const workItems = new WorkItemStore(db);
  const agentStore = new AgentStore(db);
  const projectId = seedProject(projects, { name: "p", workingDir: "/tmp/p", tmuxSessionName: "p" });
  return { db, projects, workers, workItems, agentStore, plans, projectId };
}

/** A worker with a live thread and an unfinished plan (one pending step) —
 *  stalled unless the caller gives it something that will wake it. */
function makeWorker(
  s: ReturnType<typeof setup>,
  name: string
): { workerId: string; threadId: string; itemId: string } {
  const workerId = s.workers.insert({
    projectId: s.projectId,
    name,
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: name,
    ownership: "app"
  });
  const threadId = s.agentStore.getOrCreateThread("worker", workerId).id;
  s.plans.update(workerId, { steps: [{ title: "next thing" }] });
  return { workerId, threadId, itemId: s.workItems.getByWorker(workerId)!.id };
}

describe("listStalled", () => {
  test("returns a worker that is unfinished with nothing scheduled", () => {
    const s = setup();
    const f = makeWorker(s, "stuck");
    expect(s.workItems.listStalled().map((i) => i.workerId)).toEqual([f.workerId]);
  });

  test("a running wake keeps it out", () => {
    const s = setup();
    const f = makeWorker(s, "stuck");
    s.agentStore.createWake({ threadId: f.threadId, reason: "user", triggerMessageId: null });
    expect(s.workItems.listStalled()).toEqual([]);
  });

    test("a subagent queued or running keeps it out; one that ended does not, and its thread does not list the worker twice", () => {
      // Its result wakes the worker: a worker waiting on its subagent is not stalled.
      const s = setup();
      const f = makeWorker(s, "stuck");
      const tasks = new BackgroundTaskStore(s.db);
      // As the service makes one: the child's thread for the task's id, then the task naming it.
      const taskId = newId("task");
      const child = s.agentStore.createSubagentThread(taskId);
      const task = tasks.create({ id: taskId, parentThreadId: f.threadId, childThreadId: child.id, type: "general", title: "project-1 job", task: "Do the job." });
      expect(s.workItems.listStalled()).toEqual([]);
      tasks.markRunning(task.id, new Date().toISOString());
      expect(s.workItems.listStalled()).toEqual([]);
      tasks.finish(task.id, { status: "finished", reply: "Found the call sites.", error: null, at: new Date().toISOString() });
      expect(s.workItems.listStalled().map((i) => i.workerId)).toEqual([f.workerId]);
    });

  test("a finished wake does not keep it out", () => {
    // The distinction the `finished_at is null` clause exists to draw: having
    // run is not the same as being about to run.
    const s = setup();
    const f = makeWorker(s, "stuck");
    const wake = s.agentStore.createWake({
      threadId: f.threadId,
      reason: "user",
      triggerMessageId: null
    });
    s.agentStore.finishWake(wake.id, "finished");
    expect(s.workItems.listStalled().map((i) => i.workerId)).toEqual([f.workerId]);
  });

  test("a pending alarm keeps it out", () => {
    const s = setup();
    const f = makeWorker(s, "stuck");
    s.db
      .prepare(
        `insert into agent_alarms (id, thread_id, fire_at, note, status, created_at)
         values ('al1', ?, '2099-01-01T00:00:00.000Z', 'later', 'pending', '2026-08-06T00:00:00.000Z')`
      )
      .run(f.threadId);
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("a pending command monitor keeps it out", () => {
    const s = setup();
    const f = makeWorker(s, "waiting");
    s.db.prepare(
      `insert into agent_monitors (id, thread_id, command, cwd, every_ms, wake_when, note, timeout_ms, created_at, timeout_at, next_run_at)
       values ('mon1', ?, 'gh pr checks 1', '/tmp', 300000, 'succeeds', 'ci', 86400000,
               '2026-10-04T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-04T00:05:00.000Z')`
    ).run(f.threadId);
    expect(s.workItems.listStalled()).toEqual([]);
    s.db.prepare(`delete from agent_monitors where id = 'mon1'`).run();
    expect(s.workItems.listStalled().map((i) => i.workerId)).toEqual([f.workerId]);
  });

  test("a fired alarm does not keep it out", () => {
    const s = setup();
    const f = makeWorker(s, "stuck");
    s.db
      .prepare(
        `insert into agent_alarms (id, thread_id, fire_at, note, status, created_at, fired_at)
         values ('al1', ?, '2026-01-01T00:00:00.000Z', 'done', 'fired',
                 '2026-08-06T00:00:00.000Z', '2026-08-06T00:01:00.000Z')`
      )
      .run(f.threadId);
    expect(s.workItems.listStalled().map((i) => i.workerId)).toEqual([f.workerId]);
  });

  test("an undelivered mailbox message keeps it out", () => {
    const s = setup();
    const f = makeWorker(s, "stuck");
    s.agentStore.enqueueMailboxMessage({
      threadId: f.threadId,
      role: "user",
      source: "manager",
      sourceThreadId: null,
      content: { type: "text", text: "keep going" }
    });
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("a pane monitor keeps it out", () => {
    const s = setup();
    const f = makeWorker(s, "stuck");
    s.db
      .prepare(
        `insert into agent_pane_monitors
           (id, thread_id, window_key, pane_id, note, created_at, timeout_at)
         values ('ww1', ?, 'k', 'p', '', '2026-08-06T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`
      )
      .run(f.threadId);
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("a worker with a question in its plan is waiting for the answer, not stalled; cleared, it is stalled again", () => {
    // What it asks is in its plan and no flag: without this the sweep would
    // raise a worker that is waiting on its manager or the user, every time.
    const s = setup();
    const f = makeWorker(s, "asks");
    const other = makeWorker(s, "stuck");
    s.plans.update(f.workerId, { openQuestions: ["Split the cache into its own PR?"] });
    expect(s.workItems.listStalled().map((i) => i.id)).toEqual([other.itemId]);
    s.plans.update(f.workerId, { openQuestions: [] });
    expect(s.workItems.listStalled().map((i) => i.id).sort()).toEqual([f.itemId, other.itemId].sort());
  });

  // What the plan's steps make of a worker that has nothing else to wake it;
  // makeWorker's plan starts with one pending step.
  const planShapes: { name: string; patch: Parameters<PlanStore["update"]>[1]; stalled: boolean }[] = [
    { name: "a plan with every step done is not stalled", patch: { steps: [{ id: 1, status: "done", note: "shipped" }] }, stalled: false },
    { name: "a plan whose only open step is blocked is waiting, not stalled", patch: { steps: [{ id: 1, status: "blocked", note: "waits on project-2#17" }] }, stalled: false },
    { name: "a worker with no steps yet (Planning) is not stalled", patch: { delete: [1] }, stalled: false },
    { name: "a step left in progress with nothing to wake the worker is stalled", patch: { steps: [{ id: 1, status: "in_progress" }] }, stalled: true }
  ];

  test.each(planShapes)("$name", ({ patch, stalled }) => {
    const s = setup();
    const f = makeWorker(s, "stuck");
    s.plans.update(f.workerId, patch);
    expect(s.workItems.listStalled().map((it) => it.workerId)).toEqual(stalled ? [f.workerId] : []);
  });

  test("an archived worker is not stalled", () => {
    const s = setup();
    const f = makeWorker(s, "stuck");
    s.workers.archive(f.workerId);
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("orders oldest activity first, and not in insertion order", () => {
    // Fed newest-first on purpose. A fixture inserted in the order the query
    // returns lets the `order by` be deleted with the suite still green.
    const s = setup();
    const recent = makeWorker(s, "recent");
    const older = makeWorker(s, "older");
    const oldest = makeWorker(s, "oldest");
    const stamp = (id: string, at: string) =>
      s.db.prepare("update work_items set last_activity_at = ? where id = ?").run(at, id);
    stamp(recent.itemId, "2026-08-06T00:00:00.000Z");
    stamp(older.itemId, "2026-08-04T00:00:00.000Z");
    stamp(oldest.itemId, "2026-08-01T00:00:00.000Z");

    expect(s.workItems.listStalled().map((i) => i.workerId)).toEqual([
      oldest.workerId,
      older.workerId,
      recent.workerId
    ]);
  });

  test("honours the limit", () => {
    const s = setup();
    makeWorker(s, "a");
    makeWorker(s, "b");
    makeWorker(s, "c");
    expect(s.workItems.listStalled({ limit: 2 })).toHaveLength(2);
  });
});

describe("isStalled", () => {
  test("answers for one worker what listStalled lists", () => {
    const s = setup();
    const stuck = makeWorker(s, "stuck");
    const waiting = makeWorker(s, "waiting");
    s.db
      .prepare(
        `insert into agent_alarms (id, thread_id, fire_at, note, status, created_at)
         values ('al2', ?, '2099-01-01T00:00:00.000Z', 'later', 'pending', '2026-08-06T00:00:00.000Z')`
      )
      .run(waiting.threadId);
    expect(s.workItems.isStalled(stuck.workerId)).toBe(true);
    // Another worker's stall is not this one's.
    expect(s.workItems.isStalled(waiting.workerId)).toBe(false);
    expect(s.workItems.listStalled().map((i) => i.workerId)).toEqual([stuck.workerId]);
  });
});
