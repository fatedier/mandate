import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { WorkItemChangeEmitter } from "../src/server/modules/agent/work-item-events.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { broadcastWorkItemCreated } from "../src/server/modules/agent/work-item-created-broadcast.js";
import type { SseEvent } from "../src/shared/api/sse.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

/** Production wiring: one change emitter shared by both stores, exactly as
 *  createAppStores builds them. */
function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const changes = new WorkItemChangeEmitter();
  const projects = new ProjectsStore(db);
  const featuresStore = new FeaturesStore(db, changes);
  const workStore = new WorkItemStore(db, changes);
  const sse = new AgentSseEmitter({ workItemUpdateThrottleMs: 1 });

  const received: SseEvent[] = [];
  sse.addSink((e) => received.push(e));
  const unsubscribe = broadcastWorkItemCreated({ workStore, featuresStore, sse });

  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", gitRemote: null, isGit: false
  });

  const created = () => received.filter((e) => e.event === "workItemCreated");
  return { db, projects, featuresStore, workStore, projectId, received, created, unsubscribe };
}

function insertFeature(featuresStore: FeaturesStore, projectId: string, name: string): string {
  return featuresStore.insert({
    projectId, name, mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: name, ownership: "app"
  });
}

test("creating a feature puts its bound work item on the wire", () => {
  const { featuresStore, projectId, created, unsubscribe } = setup();
  try {
    const featureId = insertFeature(featuresStore, projectId, "login");

    expect(created().length).toBe(1);
    const item = (created()[0]!.data as { item: WorkItemDto }).item;
    expect(item.featureId).toBe(featureId);
    expect(item.title).toBe("login");
    expect(item.phase).toBe("design");
    // The DTO is complete, not a stub built from the change event's ids.
    expect(item.id).toMatch(/^wi/);
    expect(item.projectId).toBe(projectId);
    expect(item.summaryUpdatedAt).toBeNull();
    expect(item.summaryUpdatedBy).toBeNull();
  } finally {
    unsubscribe();
  }
});

test("one create is one event, even though both stores are subscribed", () => {
  const { featuresStore, projectId, created, unsubscribe } = setup();
  try {
    insertFeature(featuresStore, projectId, "a");
    insertFeature(featuresStore, projectId, "b");
    expect(created().length).toBe(2);
    const featureIds = created().map((e) => (e.data as { item: WorkItemDto }).item.featureId);
    expect(new Set(featureIds).size).toBe(2);
  } finally {
    unsubscribe();
  }
});

test("updates and deletes do not masquerade as creates", () => {
  const { featuresStore, workStore, projectId, created, unsubscribe } = setup();
  try {
    const featureId = insertFeature(featuresStore, projectId, "login");
    const itemId = workStore.getByFeature(featureId)!.id;
    expect(created().length).toBe(1);

    workStore.update(itemId, { summary: "Now with a summary.", summaryBy: "worker" });
    workStore.update(itemId, { phase: "working" });
    workStore.deleteByFeature(featureId);

    expect(created().length).toBe(1);
  } finally {
    unsubscribe();
  }
});

test("disposing the runtime stops the broadcast", () => {
  const { featuresStore, projectId, created, unsubscribe } = setup();
  insertFeature(featuresStore, projectId, "before");
  expect(created().length).toBe(1);

  unsubscribe();
  insertFeature(featuresStore, projectId, "after");
  expect(created().length).toBe(1);
});

test("a work item created directly through the store is broadcast too", () => {
  const { featuresStore, workStore, projectId, created, unsubscribe } = setup();
  try {
    // features.insert already made one, so use a second feature whose row is
    // removed first — the point is that WorkItemStore.create is covered by the
    // same subscription rather than only features.insert.
    const featureId = insertFeature(featuresStore, projectId, "direct");
    workStore.deleteByFeature(featureId);
    const before = created().length;

    workStore.create({ featureId, projectId, title: "Recreated" });

    expect(created().length).toBe(before + 1);
    const last = created().at(-1)!;
    expect((last.data as { item: WorkItemDto }).item.title).toBe("Recreated");
  } finally {
    unsubscribe();
  }
});
