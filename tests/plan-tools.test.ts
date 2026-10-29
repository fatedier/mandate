import { expect, test } from "bun:test";
import { z } from "zod";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { buildPlanToolPacks } from "../src/server/modules/plans/plan-tools.js";
import type { ToolContext, ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { featureStateFor } from "../src/shared/feature-state.js";

class CapturingSse { events: Array<{ name: string; data: any }> = []; emit(name: string, data: unknown) { this.events.push({ name, data }); } }

function setup() {
  const e = freshStoresEnv("md-plan-tools-");
  const projectId = seedProject(e.projects);
  const featureId = seedFeature(e.features, projectId);
  const feature = e.features.getById(featureId)!;
  const thread = e.agentStore.getOrCreateThread("worker", featureId);
  const sse = new CapturingSse();
  const workStore = new WorkItemStore(e.store.db);
  const asked: Array<[string, string[]]> = [];
  const tools = (scope: "worker" | "manager") =>
    buildPlanToolPacks({ scope, store: e.store, agentStore: e.agentStore, featuresStore: e.features, workStore, sse: sse as unknown as AgentSseEmitter, onQuestionAsked: (id, questions) => asked.push([id, questions]) })
      .flatMap((p) => p.tools) as ToolDefinition<any, any>[];
  const workerCtx = { threadId: thread.id, wakeId: "w", scope: { kind: "worker" }, feature } as unknown as ToolContext;
  const managerCtx = { threadId: "thr_manager", wakeId: "w", scope: { kind: "manager" } } as unknown as ToolContext;
  const tool = (scope: "worker" | "manager", name: string) => tools(scope).find((t) => t.name === name)!;
  return { ...e, featureId, sse, tools, tool, workerCtx, managerCtx, workStore, asked, plans: new PlanStore(e.store.db) };
}

test("the worker gets update_plan and read_plan; the manager only read_plan", () => {
  const { tools, cleanup } = setup();
  try {
    expect(tools("worker").map((t) => t.name)).toEqual(["update_plan", "read_plan"]);
    expect(tools("manager").map((t) => t.name)).toEqual(["read_plan"]);
  } finally { cleanup(); }
});

test("update_plan answers in one line and pushes the new plan", async () => {
  const { tool, workerCtx, sse, featureId, cleanup } = setup();
  try {
    expect(await tool("worker", "update_plan").handler({ goal: "Ship A", steps: [{ title: "a" }] }, workerCtx)).toBe("Plan updated: goal; added #1 (0 of 1 done)");
    expect(sse.events.map((e) => e.name)).toEqual(["featurePlanUpdated", "workItemUpdated"]);
    expect(sse.events[0]!.data.plan.featureId).toBe(featureId);
    expect(sse.events[0]!.data.plan.steps.map((s: any) => s.title)).toEqual(["a"]);
  } finally { cleanup(); }
});

test("a refused update raises every problem and pushes nothing", async () => {
  const { tool, workerCtx, sse, cleanup } = setup();
  try {
    await expect(tool("worker", "update_plan").handler({ steps: [{ id: 3, status: "done" }, { note: "x" }] }, workerCtx))
      .rejects.toThrow("step #3 does not exist; a new step needs a title");
    expect(sse.events).toStrictEqual([]);
  } finally { cleanup(); }
});

test("read_plan reads the worker's own plan, and the manager names a feature", async () => {
  const { tool, workerCtx, managerCtx, featureId, features, cleanup } = setup();
  try {
    await tool("worker", "update_plan").handler({ conclusion: "Waiting", steps: [{ title: "a" }] }, workerCtx);
    const added = new Date().toISOString().slice(0, 10);
    const text = `Plan: 0 of 1 done\nConclusion: Waiting\nSteps:\n  #1 [pending, added ${added}] a`;
    expect(await tool("worker", "read_plan").handler({}, workerCtx)).toBe(text);
    expect(await tool("manager", "read_plan").handler({ featureId }, managerCtx)).toBe(text);
    expect(await tool("manager", "read_plan").handler({ featureId: "feat_missing" }, managerCtx)).toEqual({ error: "feature not found: feat_missing" });
    features.archive(featureId);
    expect(await tool("manager", "read_plan").handler({ featureId }, managerCtx)).toEqual({ error: `feature not found: ${featureId}` });
  } finally { cleanup(); }
});

test("update_plan says what each status means, and that a new step starts pending", () => {
  const { tool, cleanup } = setup();
  try {
    const description = tool("worker", "update_plan").description;
    expect(description).toContain("pending = not started yet (a new step starts pending)");
    expect(description).toContain("in_progress = being worked on now");
    expect(description).toContain("blocked = waiting on something outside you");
    expect(description).toContain("done = finished, with its result in the note");
  } finally { cleanup(); }
});

test("update_plan says a question goes to the manager at once and stays open until cleared", () => {
  const { tool, cleanup } = setup();
  try {
    const description = tool("worker", "update_plan").description;
    expect(description).toContain("- Update the conclusion whenever the overall picture changes. Put questions that need the manager or the user to decide in openQuestions: the manager is told at once, and a question stays open until you clear it.");
    expect(description).not.toContain("an open question asks the user for input");
  } finally { cleanup(); }
});

test("a plan that moves marks the feature active; a call that changes nothing does not", async () => {
  const { tool, workerCtx, sse, featureId, workStore, store, cleanup } = setup();
  try {
    const item = workStore.getByFeature(featureId)!;
    store.db.prepare(`update work_items set last_activity_at = '2026-01-01T00:00:00.000Z' where id = ?`).run(item.id);
    await tool("worker", "update_plan").handler({ steps: [{ title: "a" }] }, workerCtx);
    expect(workStore.getByFeature(featureId)!.lastActivityAt > "2026-01-01T00:00:00.000Z").toBe(true);
    expect(sse.events.find((e) => e.name === "workItemUpdated")!.data.item.id).toBe(item.id);
    store.db.prepare(`update work_items set last_activity_at = '2026-01-01T00:00:00.000Z' where id = ?`).run(item.id);
    sse.events.length = 0;
    await tool("worker", "update_plan").handler({ steps: [{ id: 1, title: "a" }] }, workerCtx);
    expect(workStore.getByFeature(featureId)!.lastActivityAt).toBe("2026-01-01T00:00:00.000Z");
    expect(sse.events.map((e) => e.name)).toEqual(["featurePlanUpdated"]);
  } finally { cleanup(); }
});

// What a worker asks is in its plan and nowhere else.
test("a plan whose steps are done with a question still open asks", async () => {
  const { tool, workerCtx, featureId, plans, cleanup } = setup();
  try {
    const update = tool("worker", "update_plan");
    await update.handler({ openQuestions: ["Ship it behind a flag?"], steps: [{ title: "a" }] }, workerCtx);
    await update.handler({ steps: [{ id: 1, status: "done", note: "ok" }] }, workerCtx);
    expect(featureStateFor(plans.get(featureId))).toBe("asking");
    await update.handler({ openQuestions: [] }, workerCtx);
  } finally { cleanup(); }
});

// The manager hears a question the moment it is written, not when the
// worker's turn ends: the worker may work on for minutes.
test("a question written into the plan is said at once, once: again only for a question that was not there before", async () => {
  const { tool, workerCtx, featureId, asked, cleanup } = setup();
  try {
    const update = tool("worker", "update_plan");
    await update.handler({ steps: [{ title: "Decide", status: "in_progress" }] }, workerCtx);
    expect(asked).toStrictEqual([]);
    await update.handler({ openQuestions: ["Accept the risk?"] }, workerCtx);
    expect(asked).toStrictEqual([[featureId, ["Accept the risk?"]]]);
    // The plan moves on with the question still open: nothing new is asked.
    await update.handler({ steps: [{ id: 1, note: "half way" }] }, workerCtx);
    await update.handler({ openQuestions: ["Accept the risk?"] }, workerCtx);
    expect(asked.length).toBe(1);
    // A second question beside the first: it is the new one that is said.
    await update.handler({ openQuestions: ["Accept the risk?", "Ship behind a flag?"] }, workerCtx);
    expect(asked.at(-1)).toEqual([featureId, ["Ship behind a flag?"]]);
    // One of them answered and cleared: nothing new.
    await update.handler({ openQuestions: ["Ship behind a flag?"] }, workerCtx);
    expect(asked.length).toBe(2);
    // Cleared, then two at once, one of them asked before: both are new now.
    await update.handler({ openQuestions: [] }, workerCtx);
    await update.handler({ openQuestions: ["Accept the risk?", "Tag it too?"] }, workerCtx);
    expect(asked.at(-1)).toEqual([featureId, ["Accept the risk?", "Tag it too?"]]);
    expect(asked.length).toBe(3);
  } finally { cleanup(); }
});

test("a refused update asks nothing", async () => {
  const { tool, workerCtx, asked, cleanup } = setup();
  try {
    await expect(tool("worker", "update_plan").handler({ openQuestions: ["Accept the risk?"], steps: [{ id: 9, status: "done" }] }, workerCtx)).rejects.toThrow();
    expect(asked).toStrictEqual([]);
  } finally { cleanup(); }
});

test("step ids written as the plan shows them (#3) or as strings are read as numbers; the schema still asks for integers", () => {
  const { tool, cleanup } = setup();
  try {
    const params = tool("worker", "update_plan").parameters;
    expect(params.parse({ steps: [{ id: "#1", status: "done", note: "ok" }, { title: "b", after: " 2 " }], delete: ["#3", 4] })).toEqual({
      steps: [{ id: 1, status: "done", note: "ok" }, { title: "b", after: 2 }], delete: [3, 4]
    });
    expect(params.safeParse({ steps: [{ id: "three" }] }).success).toBe(false);
    expect(params.safeParse({ delete: ["#0"] }).success).toBe(false);
    const schema = z.toJSONSchema(params) as unknown as { properties: { steps: { items: { properties: { id: { type: string } } } } } };
    expect(schema.properties.steps.items.properties.id.type).toBe("integer");
  } finally { cleanup(); }
});

test("after a goal change the pushed plan is the page's: the new work, earlier work counted", async () => {
  const { tool, workerCtx, sse, cleanup } = setup();
  try {
    const update = tool("worker", "update_plan");
    await update.handler({ goal: "Draft the notes", steps: [{ title: "a" }] }, workerCtx);
    await Bun.sleep(2);
    await update.handler({ steps: [{ id: 1, status: "done", note: "drafted" }] }, workerCtx);
    await Bun.sleep(2);
    sse.events.length = 0;
    expect(await update.handler({ goal: "Open the PR", steps: [{ title: "b" }] }, workerCtx)).toBe("Plan updated: goal; added #2 (0 of 1 done)");
    const pushed = sse.events.find((e) => e.name === "featurePlanUpdated")!.data.plan;
    expect(pushed.steps.map((s: any) => s.title)).toEqual(["b"]);
    expect(pushed.earlierWork).toEqual({ goals: 1, steps: 1, lastStepId: 1 });
  } finally { cleanup(); }
});
