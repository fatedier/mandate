import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeWorkersSchema } from "../src/server/modules/workers/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
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
  initializeWorkersSchema(db);
  initializeAgentSchema(db);
  const changes = new WorkItemChangeEmitter();
  const projects = new ProjectsStore(db);
  const workersStore = new WorkersStore(db, changes);
  const workStore = new WorkItemStore(db, changes);
  const sse = new AgentSseEmitter({ workItemUpdateThrottleMs: 1 });

  const received: SseEvent[] = [];
  sse.addSink((e) => received.push(e));
  const unsubscribe = broadcastWorkItemCreated({ workStore, workersStore, sse });

  const projectId = seedProject(projects, { name: "p", workingDir: "/tmp/p", tmuxSessionName: "p" });

  const created = () => received.filter((e) => e.event === "workItemCreated");
  return { db, projects, workersStore, workStore, projectId, received, created, unsubscribe };
}

function insertWorker(workersStore: WorkersStore, projectId: string, name: string): string {
  return workersStore.insert({
    projectId, name, mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: name, ownership: "app"
  });
}

test("creating a worker puts its bound work item on the wire", () => {
  const { workersStore, projectId, created, unsubscribe } = setup();
  try {
    const workerId = insertWorker(workersStore, projectId, "login");

    expect(created().length).toBe(1);
    const item = (created()[0]!.data as { item: WorkItemDto }).item;
    expect(item.workerId).toBe(workerId);
    expect(item.title).toBe("login");
    // The DTO is complete, not a stub built from the change event's ids.
    expect(item.id).toMatch(/^wi/);
    expect(item.projectId).toBe(projectId);
  } finally {
    unsubscribe();
  }
});

test("an update does not masquerade as a create", () => {
  const { workersStore, workStore, projectId, created, unsubscribe } = setup();
  try {
    const workerId = insertWorker(workersStore, projectId, "login");
    const itemId = workStore.getByWorker(workerId)!.id;
    expect(created().length).toBe(1);

    workStore.touch(itemId);

    expect(created().length).toBe(1);
  } finally {
    unsubscribe();
  }
});

test("disposing the runtime stops the broadcast", () => {
  const { workersStore, projectId, created, unsubscribe } = setup();
  insertWorker(workersStore, projectId, "before");
  expect(created().length).toBe(1);

  unsubscribe();
  insertWorker(workersStore, projectId, "after");
  expect(created().length).toBe(1);
});
