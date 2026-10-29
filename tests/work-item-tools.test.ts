import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { initializePlansSchema } from "../src/server/modules/plans/schema.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { buildWorkItemTools } from "../src/server/modules/agent/tools/work-item-tools.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { seedProject } from "./helpers/fixtures.js";
import { stub, toolContext } from "./helpers/typed.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  initializePlansSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const projectId = seedProject(projects, { name: "p", workingDir: "/tmp/p", tmuxSessionName: "p" });
  const featureId = features.insert({
    projectId, name: "login", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "login", ownership: "app"
  });
  const emitted: Array<{ event: string; data: unknown }> = [];
  const sse = stub<AgentSseEmitter>({ emit: (event: string, data: unknown) => { emitted.push({ event, data }); } });
  const plans = new PlanStore(db);
  const tools = buildWorkItemTools({ workStore: workItems, sse, planStore: plans });
  const byName = new Map(tools.map((t) => [t.name, t]));
  // features.insert auto-creates a bound work item; retrieve it rather than creating a duplicate.
  const seedItem = () => workItems.getByFeature(featureId)!;
  return { workItems, plans, featureId, projectId, sse, emitted, byName: (n: string) => byName.get(n)!, seedItem };
}

const ctx = toolContext({ threadId: "thread-1" });

test("a manager's work item tools are dismiss_work_item alone", () => {
  const db = new Database(":memory:");
  const workStore = new WorkItemStore(db);
  const sse = stub<AgentSseEmitter>({ emit: () => {} });
  expect(buildWorkItemTools({ workStore, sse }).map((t) => t.name)).toEqual(["dismiss_work_item"]);
});

test("dismiss_work_item says it clears a plan's questions; a question to the user goes through ask_user", () => {
  const { byName } = setup();
  expect(byName("dismiss_work_item").description).toBe(
    "Clear the open questions in a worker's plan when they no longer need an answer (answered another way, or no longer needed)."
  );
});

// What a worker asks is in its plan. A question answered another way, or no
// longer needed, would keep the worker waiting for an answer for good: the
// manager clears it here, since only the worker writes the plan.
test("dismiss_work_item also clears the open questions of the worker's plan, and says the plan changed", async () => {
  const { plans, featureId, byName, emitted, seedItem } = setup();
  const created = seedItem();
  plans.update(featureId, { conclusion: "Waiting", openQuestions: ["Keep the old flag as an alias?", "Ship behind a flag?"], steps: [{ title: "Decide" }] });
  const res = await byName("dismiss_work_item").handler({ id: created.id, reason: "answered in the thread" }, ctx);
  expect(res).toEqual({ ok: true });
  const plan = plans.get(featureId);
  expect(plan.openQuestions).toEqual([]);
  // Nothing else of the plan is touched.
  expect([plan.conclusion, plan.steps.map((step) => [step.title, step.status])]).toEqual(["Waiting", [["Decide", "pending"]]]);
  expect(emitted.map((e) => e.event)).toStrictEqual(["featurePlanUpdated", "workItemUpdated"]);
  expect((emitted[0]!.data as { plan: { featureId: string; openQuestions: string[] } }).plan).toMatchObject({ featureId, openQuestions: [] });
  // A plan that asks nothing is left alone: no plan event.
  emitted.length = 0;
  expect(await byName("dismiss_work_item").handler({ id: created.id }, ctx)).toEqual({ ok: true });
  expect(emitted.map((e) => e.event)).toStrictEqual(["workItemUpdated"]);
});

test("dismiss_work_item returns error for missing item", async () => {
  const { byName } = setup();
  const tool = byName("dismiss_work_item");
  const res = await tool.handler(
    { id: "no-such-item" },
    ctx
  );
  expect((res as any).error).toMatch(/no-such-item/);
});

// The managers' sweep listens for work item changes: a worker whose question
// is dismissed may have steps left and nothing to wake it, and a sweep that
// had stopped must look again.
test("dismiss_work_item tells the work item's listeners the worker changed", async () => {
  const { workItems, byName, seedItem, plans, featureId } = setup();
  const created = seedItem();
  plans.update(featureId, { openQuestions: ["Keep the old flag?"], steps: [{ title: "Decide" }, { title: "Ship" }] });
  const changed: string[] = [];
  workItems.onChange((event) => changed.push(event.featureId));
  expect(await byName("dismiss_work_item").handler({ id: created.id }, ctx)).toEqual({ ok: true });
  expect(changed).toStrictEqual([featureId]);
});
