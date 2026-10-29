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
import { seedProject } from "./helpers/fixtures.js";

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

  const projectId = seedProject(projects, { name: "p", workingDir: "/tmp/p", tmuxSessionName: "p" });

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
    // The DTO is complete, not a stub built from the change event's ids.
    expect(item.id).toMatch(/^wi/);
    expect(item.projectId).toBe(projectId);
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

    workStore.touch(itemId);
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
