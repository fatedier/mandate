import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import { categorizeFeatures } from "../../src/client/routes/projects/feature-card-data.js";
import type { Feature } from "../../src/client/store/projects.js";
import type { WorkItemDto } from "../../src/shared/api/work-items.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", gitRemote: null, isGit: false
  });
  return { db, features, workItems, projectId };
}

function toFeatureDto(row: any): Feature {
  return {
    ...row,
    tmuxAlive: true,
    tmuxStatus: "alive"
  };
}

function toWorkItemDto(item: any): WorkItemDto {
  return { ...item };
}

test("E2E categorize: needsUser=input -> attention bucket; idle -> working bucket", () => {
  const { features, workItems, projectId } = setup();
  const f1 = features.insert({
    projectId, name: "a", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "wa", ownership: "app"
  });
  const f2 = features.insert({
    projectId, name: "b", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "wb", ownership: "app"
  });
  // f1 → needs input
  const item1 = workItems.getByFeature(f1)!;
  workItems.update(item1.id, { needsUser: "input" });
  // f2 stays passive

  const featureList = [features.getById(f1)!, features.getById(f2)!].map(toFeatureDto);
  const itemMap = new Map<string, WorkItemDto>();
  itemMap.set(f1, toWorkItemDto(workItems.getByFeature(f1)));
  itemMap.set(f2, toWorkItemDto(workItems.getByFeature(f2)));

  const buckets = categorizeFeatures(featureList, itemMap);
  expect(buckets.attention.map((b) => b.feature.id)).toEqual([f1]);
  expect(buckets.working.map((b) => b.feature.id)).toEqual([f2]);
});

test("E2E categorize: pinned attention item appears in pinned bucket", () => {
  const { features, workItems, projectId } = setup();
  const f1 = features.insert({
    projectId, name: "a", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "wa", ownership: "app"
  });
  workItems.update(workItems.getByFeature(f1)!.id, { needsUser: "input" });
  features.setPinned(f1, true);

  const featureList = [features.getById(f1)!].map(toFeatureDto);
  const itemMap = new Map<string, WorkItemDto>();
  itemMap.set(f1, toWorkItemDto(workItems.getByFeature(f1)));

  const buckets = categorizeFeatures(featureList, itemMap);
  expect(buckets.pinned.map((b) => b.feature.id)).toEqual([f1]);
  expect(buckets.attention).toEqual([]);
});

test("E2E categorize: feature without work_item -> untracked bucket", () => {
  const { db, features, projectId } = setup();
  const f1 = features.insert({
    projectId, name: "orphan", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "worphan", ownership: "app"
  });
  db.prepare("delete from work_items where feature_id = ?").run(f1);

  const featureList = [features.getById(f1)!].map(toFeatureDto);
  const buckets = categorizeFeatures(featureList, new Map());
  expect(buckets.untracked.map((b) => b.feature.id)).toEqual([f1]);
});
