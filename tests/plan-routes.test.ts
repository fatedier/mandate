import { expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { mountPlanRoutes } from "../src/server/modules/plans/plan-routes.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";

test("a feature's plan is served; a missing feature is a 404", async () => {
  const { store, projects, features } = freshStoresEnv("md-plan-routes-");
  const app = new Hono();
  mountPlanRoutes(app, { store, features });
  const projectId = seedProject(projects);
  const featureId = seedFeature(features, projectId);
  new PlanStore(store.db).update(featureId, { conclusion: "Waiting", steps: [{ title: "a" }] });
  const one = await (await app.request(`/api/features/${featureId}/plan`)).json();
  expect(one.plan.conclusion).toBe("Waiting");
  expect(one.plan.steps.map((s: any) => s.title)).toEqual(["a"]);
  // Every active plan reaches the client as a connection opens, not here.
  expect((await app.request("/api/feature-plans")).status).toBe(404);
  expect((await app.request("/api/features/feat_missing/plan")).status).toBe(404);
});

test("the plan the page reads is the current work with earlier work counted; ?history=1 is the whole plan", async () => {
  const { store, projects, features } = freshStoresEnv("md-plan-routes-rounds-");
  const app = new Hono();
  mountPlanRoutes(app, { store, features });
  const featureId = seedFeature(features, seedProject(projects));
  let tick = 0;
  const plans = new PlanStore(store.db, () => new Date(Date.UTC(2026, 9, 12, 8, 0, tick++)).toISOString());
  plans.update(featureId, { goal: "Draft the notes", steps: [{ title: "a" }] });
  plans.update(featureId, { steps: [{ id: 1, status: "done", note: "drafted" }] });
  plans.update(featureId, { goal: "Open the PR", steps: [{ title: "b" }] });
  const page = (await (await app.request(`/api/features/${featureId}/plan`)).json()).plan;
  expect(page.steps.map((s: any) => s.title)).toEqual(["b"]);
  expect(page.goalHistory).toEqual([]);
  expect(page.earlierWork).toEqual({ goals: 1, steps: 1, lastStepId: 1 });
  const whole = (await (await app.request(`/api/features/${featureId}/plan?history=1`)).json()).plan;
  expect(whole.steps.map((s: any) => s.title)).toEqual(["a", "b"]);
  expect(whole.goalHistory.map((g: any) => g.goal)).toEqual(["Draft the notes"]);
  expect(whole.earlierWork).toBeUndefined();
});

// A worker's task record, for its Plan tab: whole, with when it was last rewritten.
test("the record route returns a feature's record, null without one, 404 for an unknown feature", async () => {
  const { store, projects, features } = freshStoresEnv("md-plan-routes-record-");
  const app = new Hono();
  mountPlanRoutes(app, { store, features });
  const projectId = seedProject(projects);
  const featureId = seedFeature(features, projectId);
  const none = await app.request(`/api/features/${featureId}/record`);
  expect([none.status, await none.json()]).toEqual([200, { record: null }]);
  const written = new FeatureRecordStore(store.db).write({ featureId, projectId, content: "Export rows\nDone: every step", sourceThreadId: null, metadata: null }).record;
  const one = await app.request(`/api/features/${featureId}/record`);
  expect(one.headers.get("cache-control")).toBe("no-store");
  expect(await one.json()).toEqual({ record: { id: written.id, content: "Export rows\nDone: every step", updatedAt: written.updatedAt } });
  const missing = await app.request("/api/features/feat_missing/record");
  expect([missing.status, await missing.json()]).toEqual([404, { error: "feature not found" }]);
});
