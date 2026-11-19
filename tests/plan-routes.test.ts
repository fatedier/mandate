import { expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { mountPlanRoutes } from "../src/server/modules/plans/plan-routes.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";

test("a worker's plan is served; a missing worker is a 404", async () => {
  const { store, projects, workers } = freshStoresEnv("md-plan-routes-");
  const app = new Hono();
  mountPlanRoutes(app, { store, workers });
  const projectId = seedProject(projects);
  const workerId = seedWorker(workers, projectId);
  new PlanStore(store.db).update(workerId, { conclusion: "Waiting", steps: [{ title: "a" }] });
  const one = await (await app.request(`/api/workers/${workerId}/plan`)).json();
  expect(one.plan.conclusion).toBe("Waiting");
  expect(one.plan.steps.map((s: any) => s.title)).toEqual(["a"]);
  // Every active plan reaches the client as a connection opens, not here.
  expect((await app.request("/api/worker-plans")).status).toBe(404);
  expect((await app.request("/api/workers/wkr_missing/plan")).status).toBe(404);
});

test("the plan the page reads is the current work with earlier work counted; ?history=1 is the whole plan", async () => {
  const { store, projects, workers } = freshStoresEnv("md-plan-routes-rounds-");
  const app = new Hono();
  mountPlanRoutes(app, { store, workers });
  const workerId = seedWorker(workers, seedProject(projects));
  let tick = 0;
  const plans = new PlanStore(store.db, () => new Date(Date.UTC(2026, 9, 12, 8, 0, tick++)).toISOString());
  plans.update(workerId, { goal: "Draft the notes", steps: [{ title: "a" }] });
  plans.update(workerId, { steps: [{ id: 1, status: "done", note: "drafted" }] });
  plans.update(workerId, { goal: "Open the PR", steps: [{ title: "b" }] });
  const page = (await (await app.request(`/api/workers/${workerId}/plan`)).json()).plan;
  expect(page.steps.map((s: any) => s.title)).toEqual(["b"]);
  expect(page.goalHistory).toStrictEqual([]);
  expect(page.earlierWork).toEqual({ goals: 1, steps: 1, lastStepId: 1 });
  const whole = (await (await app.request(`/api/workers/${workerId}/plan?history=1`)).json()).plan;
  expect(whole.steps.map((s: any) => s.title)).toEqual(["a", "b"]);
  expect(whole.goalHistory.map((g: any) => g.goal)).toEqual(["Draft the notes"]);
  expect(whole.earlierWork).toBeUndefined();
});

// A worker's task record, for its Plan tab: whole, with when it was last rewritten.
test("the record route returns a worker's record, null without one, 404 for an unknown worker", async () => {
  const { store, projects, workers } = freshStoresEnv("md-plan-routes-record-");
  const app = new Hono();
  mountPlanRoutes(app, { store, workers });
  const projectId = seedProject(projects);
  const workerId = seedWorker(workers, projectId);
  const none = await app.request(`/api/workers/${workerId}/record`);
  expect([none.status, await none.json()]).toEqual([200, { record: null }]);
  const written = new WorkerRecordStore(store.db).write({ workerId, projectId, content: "Export rows\nDone: every step"}).record;
  const one = await app.request(`/api/workers/${workerId}/record`);
  expect(one.headers.get("cache-control")).toBe("no-store");
  expect(await one.json()).toEqual({ record: { id: written.id, content: "Export rows\nDone: every step", updatedAt: written.updatedAt } });
  const missing = await app.request("/api/workers/wkr_missing/record");
  expect([missing.status, await missing.json()]).toEqual([404, { error: "worker not found" }]);
});
