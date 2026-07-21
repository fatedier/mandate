import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { buildWorkItemTools } from "../src/server/modules/agent/tools/work-item-tools.js";

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
  const emitted: Array<{ event: string; data: unknown }> = [];
  const sse = { emit: (event: string, data: unknown) => { emitted.push({ event, data }); } } as any;
  const tools = buildWorkItemTools({ workStore: workItems, sse });
  const byName = new Map(tools.map((t) => [t.name, t]));
  // features.insert auto-creates a bound work item; retrieve it rather than creating a duplicate.
  const seedItem = () => workItems.getByFeature(featureId)!;
  return { workItems, featureId, projectId, sse, emitted, byName: (n: string) => byName.get(n)!, seedItem };
}

const ctx = { threadId: "thread-1", scope: "manager" as const };

test("buildWorkItemTools exports exactly [update_work_item, dismiss_work_item]", () => {
  const db = new Database(":memory:");
  const workStore = new WorkItemStore(db);
  const sse = { emit: () => {} } as any;
  const tools = buildWorkItemTools({ workStore, sse });
  expect(tools.map((t) => t.name).sort()).toEqual([
    "dismiss_work_item", "update_work_item"
  ]);
});

test("update_work_item changes needsUser on existing item", async () => {
  const { workItems, byName, emitted, seedItem } = setup();
  const created = seedItem();
  const tool = byName("update_work_item");
  const res = await tool.handler(
    { id: created.id, patch: { needsUser: "input" } } as any,
    ctx as any
  );
  expect((res as any).ok).toBe(true);
  const item = workItems.get(created.id);
  expect(item?.needsUser).toBe("input");
  expect(emitted.some((e) => e.event === "workItemUpdated")).toBe(true);
});

test("update_work_item returns error for missing item", async () => {
  const { byName } = setup();
  const tool = byName("update_work_item");
  const res = await tool.handler(
    { id: "bogus-id-xyz", patch: { needsUser: "input" } } as any,
    ctx as any
  );
  expect((res as any).error).toMatch(/bogus-id-xyz/);
});

test("update_work_item zod rejects setting phase or phaseDetail (overview tool — those are feature's)", () => {
  const { byName } = setup();
  const tool = byName("update_work_item");
  const result = tool.parameters.safeParse({ id: "x", patch: { phase: "design" } });
  expect(result.success).toBe(false);
});

test("update_work_item zod accepts needsUser=null, review, input", () => {
  const { byName } = setup();
  const tool = byName("update_work_item");
  expect(tool.parameters.safeParse({ id: "x", patch: { needsUser: null } }).success).toBe(true);
  expect(tool.parameters.safeParse({ id: "x", patch: { needsUser: "review" } }).success).toBe(true);
  expect(tool.parameters.safeParse({ id: "x", patch: { needsUser: "input" } }).success).toBe(true);
  expect(tool.parameters.safeParse({ id: "x", patch: { needsUser: "bogus" } }).success).toBe(false);
});

test("dismiss_work_item clears needsUser to null and emits SSE", async () => {
  const { workItems, byName, emitted, seedItem } = setup();
  const created = seedItem();
  // Set needsUser so dismiss has something to clear
  workItems.update(created.id, { needsUser: "review" });
  const tool = byName("dismiss_work_item");
  const res = await tool.handler(
    { id: created.id } as any,
    ctx as any
  );
  expect((res as any).ok).toBe(true);
  const item = workItems.get(created.id);
  expect(item?.needsUser).toBeNull();
  expect(emitted.some((e) => e.event === "workItemUpdated")).toBe(true);
});

test("dismiss_work_item returns error for missing item", async () => {
  const { byName } = setup();
  const tool = byName("dismiss_work_item");
  const res = await tool.handler(
    { id: "no-such-item" } as any,
    ctx as any
  );
  expect((res as any).error).toMatch(/no-such-item/);
});

test("re-running initializeAgentSchema does not wipe existing needsUser", () => {
  const { workItems, seedItem } = setup();
  const item = seedItem();
  workItems.update(item.id, { needsUser: "review" });
  expect(workItems.get(item.id)?.needsUser).toBe("review");

  // Simulate a server restart: schema init runs again on the same DB.
  initializeAgentSchema((workItems as any).db);
  expect(workItems.get(item.id)?.needsUser).toBe("review");
});
