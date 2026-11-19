import { expect, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeWorkersSchema } from "../src/server/modules/workers/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { initializePlansSchema } from "../src/server/modules/plans/schema.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { registerWorkItemsRoutes } from "../src/server/modules/agent/work-items-routes.js";
import type { WorkItem } from "../src/server/modules/agent/work-item-store.js";
import type { WorkItemResponse, WorkItemsListResponse } from "../src/shared/api/work-items.js";
import { seedProject } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeWorkersSchema(db);
  initializePlansSchema(db);
  initializeAgentSchema(db);
  const planStore = new PlanStore(db);
  const projects = new ProjectsStore(db);
  const workers = new WorkersStore(db);
  const agentStore = new AgentStore(db);
  const workStore = new WorkItemStore(db);

  const projectId = seedProject(projects);

  const app = new Hono();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const sse = stub<AgentSseEmitter>({ emit: (event: string, data: unknown) => emitted.push({ event, data }) });
  registerWorkItemsRoutes(app, { workStore, sse, planStore });

  /**
   * Seed a work item: creates a new worker (which auto-creates a bound work_item),
   * then patches state/title as needed. Returns the work item.
   */
  function seedItem(opts: {
    title: string;
    lastActivityAt?: string;
    projectId?: string;
  }): WorkItem {
    const workerId = workers.insert({
      projectId: opts.projectId ?? projectId,
      name: opts.title,
      mode: "shared-cwd",
      branch: null,
      worktreePath: null,
      tmuxWindowName: opts.title,
      ownership: "app"
    });
    // workers.insert auto-creates a work_item bound to this worker
    let item = workStore.getByWorker(workerId)!;
    if (opts.lastActivityAt) {
      db.prepare("update work_items set last_activity_at = ? where id = ?")
        .run(opts.lastActivityAt, item.id);
      item = workStore.get(item.id)!;
    }
    return item;
  }

  return { app, planStore, agentStore, workStore, workers, projects, db, projectId, emitted, seedItem };
}

// ---------------------------------------------------------------------------
// Existing tests — updated to new DTO shape and schema
// ---------------------------------------------------------------------------

test("work item lists exclude archived workers, archived projects and missing scopes", async () => {
  const { app, db, seedItem, projects, workers, workStore } = setup();
  try {
    const idle = seedItem({ title: "Idle" });
    const failed = seedItem({ title: "Failed first" });
    const stopped = seedItem({ title: "Stopped" });
    const done = seedItem({ title: "Done" });
    const archivedWorker = seedItem({ title: "Archived worker" });
    workers.archive(archivedWorker.workerId);
    const archivedProjectId = seedProject(projects, {
      name: "Archived project", workingDir: "/tmp/archived", tmuxSessionName: "archived-project"
    });
    const archivedProjectItem = seedItem({ title: "Archived project item", projectId: archivedProjectId });
    // Deliberately leave the child unarchived: checking only the worker is insufficient.
    db.prepare("update projects set archived_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", archivedProjectId);
    expect(workers.getById(archivedProjectItem.workerId)?.archivedAt).toBeNull();
    const orphan = seedItem({ title: "Missing project" });
    db.prepare("update work_items set project_id = ? where id = ?").run("missing-project", orphan.id);
    // What needs attention is a failed or stopped wake: the archived ones are left out too.
    for (const it of [failed, stopped, archivedWorker, archivedProjectItem, orphan]) {
      workStore.setFailure(it.workerId, { at: "2026-01-02T00:00:00.000Z", message: "boom", kind: it === stopped ? "stopped" : "error" });
    }

    const res = await app.request("/api/work-items");
    expect(res.status).toBe(200);
    const body = await res.json() as WorkItemsListResponse;
    expect(body.items.map(item => item.id).sort()).toEqual([idle.id, failed.id, stopped.id, done.id].sort());
    expect(workStore.listAttention({ limit: 2, unarchivedOnly: true }).map(item => item.id).sort()).toEqual([failed.id, stopped.id].sort());
    // Internal readers retain their existing historical scope.
    expect(workStore.list({ limit: 20 })).toHaveLength(7);
  } finally { db.close(); }
});

test("work item worker lookup hides archived scope", async () => {
  const { app, db, seedItem, workers, projectId } = setup();
  try {
    const item = seedItem({ title: "Retained history" });
    for (const archive of [
      () => workers.archive(item.workerId),
      () => db.prepare("update projects set archived_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", projectId)
    ]) {
      archive();
      for (const suffix of ["", "&limit=200"]) {
        const list = await app.request(`/api/work-items?workerId=${item.workerId}${suffix}`);
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual({ items: [] });
      }
      // Separate the project-only archive case from the worker archive case.
      db.prepare("update workers set archived_at = null where id = ?").run(item.workerId);
    }
  } finally { db.close(); }
});

// The page's acknowledge control: what a worker asks is in its plan, so its
// questions go; the worker counts as active now.
test("POST /api/work-items/:id/acknowledge clears the plan's questions, marks the worker active, and says both changed", async () => {
  const { app, planStore, emitted, seedItem, db } = setup();
  const item = seedItem({ title: "Asks", lastActivityAt: "2026-01-01T00:00:00.000Z" });
  planStore.update(item.workerId, { conclusion: "Waiting", openQuestions: ["Keep the old flag as an alias?"], steps: [{ title: "Decide" }] });
  emitted.length = 0;
  const res = await app.request(`/api/work-items/${item.id}/acknowledge`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemResponse;
  expect(body.item.id).toBe(item.id);
  expect("needsUser" in body.item).toBe(false);
  expect(body.item.lastActivityAt > "2026-01-01T00:00:00.000Z").toBe(true);
  const plan = planStore.get(item.workerId);
  expect([plan.openQuestions, plan.conclusion, plan.steps.length]).toEqual([[], "Waiting", 1]);
  expect(emitted.map((e) => e.event)).toStrictEqual(["workerPlanUpdated", "workItemUpdated"]);
  db.close();
});

test("acknowledging a worker that does not exist is a 404 that changes nothing", async () => {
  const { app, emitted, db } = setup();
  emitted.length = 0;
  const res = await app.request("/api/work-items/wi_missing/acknowledge", { method: "POST" });
  expect([res.status, emitted]).toStrictEqual([404, []]);
  db.close();
});

// The retired flag's PATCH is gone with it.
test("a work item cannot be patched any more", async () => {
  const { app, seedItem, db } = setup();
  const item = seedItem({ title: "T" });
  const res = await app.request(`/api/work-items/${item.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({})
  });
  expect(res.status).toBe(404);
  db.close();
});

// ---------------------------------------------------------------------------
// Pagination tests
// ---------------------------------------------------------------------------
