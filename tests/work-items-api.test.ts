import { expect, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { initializePlansSchema } from "../src/server/modules/plans/schema.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
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
  initializeFeaturesSchema(db);
  initializePlansSchema(db);
  initializeAgentSchema(db);
  const planStore = new PlanStore(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const agentStore = new AgentStore(db);
  const workStore = new WorkItemStore(db);

  const projectId = seedProject(projects);

  const app = new Hono();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const sse = stub<AgentSseEmitter>({ emit: (event: string, data: unknown) => emitted.push({ event, data }) });
  registerWorkItemsRoutes(app, { workStore, sse, planStore });

  /**
   * Seed a work item: creates a new feature (which auto-creates a bound work_item),
   * then patches state/title as needed. Returns the work item.
   */
  function seedItem(opts: {
    title: string;
    lastActivityAt?: string;
    projectId?: string;
  }): WorkItem {
    const fid = features.insert({
      projectId: opts.projectId ?? projectId,
      name: opts.title,
      mode: "shared-cwd",
      branch: null,
      worktreePath: null,
      tmuxWindowName: opts.title,
      ownership: "app"
    });
    // features.insert auto-creates a work_item bound to this feature
    let item = workStore.getByFeature(fid)!;
    if (opts.lastActivityAt) {
      db.prepare("update work_items set last_activity_at = ? where id = ?")
        .run(opts.lastActivityAt, item.id);
      item = workStore.get(item.id)!;
    }
    return item;
  }

  return { app, planStore, agentStore, workStore, features, projects, db, projectId, emitted, seedItem };
}

// ---------------------------------------------------------------------------
// Existing tests — updated to new DTO shape and schema
// ---------------------------------------------------------------------------

test("work item lists exclude archived workers, archived projects and missing scopes", async () => {
  const { app, db, seedItem, projects, features, workStore } = setup();
  try {
    const idle = seedItem({ title: "Idle" });
    const failed = seedItem({ title: "Failed first" });
    const stopped = seedItem({ title: "Stopped" });
    const done = seedItem({ title: "Done" });
    const archivedWorker = seedItem({ title: "Archived worker" });
    features.archive(archivedWorker.featureId);
    const archivedProjectId = seedProject(projects, {
      name: "Archived project", workingDir: "/tmp/archived", tmuxSessionName: "archived-project"
    });
    const archivedProjectItem = seedItem({ title: "Archived project item", projectId: archivedProjectId });
    // Deliberately leave the child unarchived: checking only the worker is insufficient.
    db.prepare("update projects set archived_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", archivedProjectId);
    expect(features.getById(archivedProjectItem.featureId)?.archivedAt).toBeNull();
    const orphan = seedItem({ title: "Missing project" });
    db.prepare("update work_items set project_id = ? where id = ?").run("missing-project", orphan.id);
    // What needs attention is a failed or stopped wake: the archived ones are left out too.
    for (const it of [failed, stopped, archivedWorker, archivedProjectItem, orphan]) {
      workStore.setFailure(it.featureId, { at: "2026-01-02T00:00:00.000Z", message: "boom", kind: it === stopped ? "stopped" : "error" });
    }

    for (const [query, expected] of [
      ["", [idle.id, failed.id, stopped.id, done.id]],
      ["?attention=1&limit=2", [failed.id, stopped.id]]
    ] as const) {
      const res = await app.request(`/api/work-items${query}`);
      expect(res.status).toBe(200);
      const body = await res.json() as WorkItemsListResponse;
      expect(body.items.map(item => item.id).sort()).toEqual([...expected].sort());
    }
    // Internal readers retain their existing historical scope.
    expect(workStore.list({ limit: 20 })).toHaveLength(7);
  } finally { db.close(); }
});

test("work item feature lookup hides archived scope", async () => {
  const { app, db, seedItem, features, projectId } = setup();
  try {
    const item = seedItem({ title: "Retained history" });
    for (const archive of [
      () => features.archive(item.featureId),
      () => db.prepare("update projects set archived_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", projectId)
    ]) {
      archive();
      for (const suffix of ["", "&attention=1&limit=200"]) {
        const list = await app.request(`/api/work-items?featureId=${item.featureId}${suffix}`);
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual({ items: [], nextCursor: null });
      }
      // Separate the project-only archive case from the worker archive case.
      db.prepare("update features set archived_at = null where id = ?").run(item.featureId);
    }
  } finally { db.close(); }
});

test("work item pagination filters archived rows before selecting the page and cursor", async () => {
  const { app, db, seedItem, features } = setup();
  try {
    const oldest = seedItem({ title: "Oldest", lastActivityAt: "2026-01-01T00:00:00.000Z" });
    const middle = seedItem({ title: "Middle", lastActivityAt: "2026-01-02T00:00:00.000Z" });
    const newest = seedItem({ title: "Newest", lastActivityAt: "2026-01-03T00:00:00.000Z" });
    for (let i = 0; i < 5; i++) {
      features.archive(seedItem({ title: `Archived ${i}` }).featureId);
    }
    for (const query of ["attention=0"]) {
      const first = await (await app.request(`/api/work-items?${query}&limit=2`)).json();
      expect(first.items.map((item: WorkItem) => item.id)).toEqual([newest.id, middle.id]);
      expect(first.nextCursor).toBe(middle.lastActivityAt);
      const second = await (await app.request(`/api/work-items?${query}&limit=2&before=${encodeURIComponent(first.nextCursor)}`)).json();
      expect(second.items.map((item: WorkItem) => item.id)).toEqual([oldest.id]);
      expect(second.nextCursor).toBeNull();
    }
  } finally { db.close(); }
});

// The page's acknowledge control: what a worker asks is in its plan, so its
// questions go; the worker counts as active now.
test("POST /api/work-items/:id/acknowledge clears the plan's questions, marks the worker active, and says both changed", async () => {
  const { app, planStore, emitted, seedItem, db } = setup();
  const item = seedItem({ title: "Asks", lastActivityAt: "2026-01-01T00:00:00.000Z" });
  planStore.update(item.featureId, { conclusion: "Waiting", openQuestions: ["Keep the old flag as an alias?"], steps: [{ title: "Decide" }] });
  emitted.length = 0;
  const res = await app.request(`/api/work-items/${item.id}/acknowledge`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemResponse;
  expect(body.item.id).toBe(item.id);
  expect("needsUser" in body.item).toBe(false);
  expect(body.item.lastActivityAt > "2026-01-01T00:00:00.000Z").toBe(true);
  const plan = planStore.get(item.featureId);
  expect([plan.openQuestions, plan.conclusion, plan.steps.length]).toEqual([[], "Waiting", 1]);
  expect(emitted.map((e) => e.event)).toStrictEqual(["featurePlanUpdated", "workItemUpdated"]);
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
