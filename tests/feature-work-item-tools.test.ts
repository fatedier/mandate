import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore, WORK_ITEM_SUMMARY_MAX_CHARS } from "../src/server/modules/agent/work-item-store.js";
import { buildFeatureWorkItemTool } from "../src/server/modules/agent/tools/feature-work-item-tools.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p", isGit: false,
    gitRemote: null, ownership: "app"
  });
  const featureId = features.insert({
    projectId, name: "login", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "login", ownership: "app"
  });
  const sse = { emit: () => {} } as any;
  return { db, workItems, featureId, sse };
}

test("update_my_work_item updates phase + phaseDetail on the feature's bound item", async () => {
  const { workItems, featureId, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => featureId
  });
  const result = await tool.handler({ phase: "working", phaseDetail: "writing tests" }, { threadId: "t-1" } as any);
  expect(result).toEqual({ ok: true });
  const it = workItems.getByFeature(featureId)!;
  expect(it.phase).toBe("working");
  expect(it.phaseDetail).toBe("writing tests");
});

test("update_my_work_item rejects unknown phase via zod", async () => {
  const { workItems, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => null
  });
  expect(() => tool.parameters.parse({ phase: "bogus" })).toThrow();
});

test("update_my_work_item phase=done flags the item for review", async () => {
  const { workItems, featureId, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => featureId
  });
  const result = await tool.handler({ phase: "done", summary: "shipped" }, { threadId: "t-1" } as any);
  expect(result).toEqual({ ok: true });
  const it = workItems.getByFeature(featureId)!;
  expect(it.phase).toBe("done");
  expect(it.needsUser).toBe("review");
});

test("update_my_work_item rejects any status (including pending/resolved/dismissed) via zod", async () => {
  // Workers cannot set status. Only manager/user can.
  const { workItems, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => null
  });
  expect(() => tool.parameters.parse({ status: "dismissed" })).toThrow();
  expect(() => tool.parameters.parse({ status: "resolved" })).toThrow();
  expect(() => tool.parameters.parse({ status: "pending" })).toThrow();
});

test("update_my_work_item errors when thread is not scoped to a feature", async () => {
  const { workItems, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => null
  });
  const result = await tool.handler({ phase: "working" }, { threadId: "t-1" } as any);
  expect("error" in (result as object)).toBe(true);
});

test("update_my_work_item errors when feature has no bound item", async () => {
  const { workItems, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => "feat-no-such"
  });
  const result = await tool.handler({ phase: "working" }, { threadId: "t-1" } as any);
  expect("error" in (result as object)).toBe(true);
});

test("update_my_work_item requires at least one field via zod", async () => {
  const { workItems, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => null
  });
  expect(() => tool.parameters.parse({})).toThrow();
});

test("update_my_work_item bumps last_activity_at", async () => {
  const { workItems, featureId, sse } = setup();
  const before = workItems.getByFeature(featureId)!;
  await new Promise((r) => setTimeout(r, 10));
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => featureId
  });
  await tool.handler({ phaseDetail: "still going" }, { threadId: "t-1" } as any);
  const after = workItems.getByFeature(featureId)!;
  expect(after.lastActivityAt > before.lastActivityAt).toBe(true);
});

test("update_my_work_item accepts summary field (cap enforced)", async () => {
  const { workItems, featureId, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => featureId
  });
  const longText = "a".repeat(WORK_ITEM_SUMMARY_MAX_CHARS + 200);
  const result = await tool.handler({ summary: longText }, { threadId: "t-1" } as any);
  expect(result).toEqual({ ok: true });
  const item = workItems.getByFeature(featureId)!;
  expect(item.summary).toHaveLength(WORK_ITEM_SUMMARY_MAX_CHARS);
});

test("update_my_work_item params include summary; do NOT include body", () => {
  const { workItems, sse } = setup();
  const tool = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => null
  });
  expect(() => tool.parameters.parse({ summary: "hello" })).not.toThrow();
  // body should no longer be accepted (with strict schema)
  expect(() => tool.parameters.parse({ body: "x" })).toThrow();
});
