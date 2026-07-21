import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { buildFeatureWorkItemTool } from "../../src/server/modules/agent/tools/feature-work-item-tools.js";
import { buildFeatureTaskTools } from "../../src/server/modules/agent/tools/feature-task-tools.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const agentStore = new AgentStore(db);
  const overview = agentStore.getOrCreateThread("manager", null);
  const wakeCalls: any[] = [];
  const wakeScheduler = {
    wake: (...args: any[]) => { wakeCalls.push(args); return null; },
    getRunningWakeForThread: () => null
  };
  const sse = { emit: () => {} } as any;
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p", isGit: false,
    gitRemote: null, ownership: "app"
  });
  return { db, projects, features, workItems, agentStore, overview, wakeScheduler, wakeCalls, sse, projectId };
}

test("scenario A: feature progression — task_complete flags review and wakes caller", async () => {
  const { db, features, workItems, agentStore, overview, wakeScheduler, wakeCalls, sse, projectId } = setup();

  // 1. Create feature (auto-creates work_item per T4)
  const featureId = features.insert({
    projectId, name: "login", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "login", ownership: "app"
  });
  // Bind a canvas — task_complete now requires one for overview-dispatched
  // main work. Stub binding suffices for the test; no real canvas content.
  workItems.setCanvasIdForFeature(featureId, "canvas_stub");
  const featureThread = agentStore.getOrCreateThread("worker", featureId);

  // 2. Build tools with same deps prod code uses
  const updateMyItem = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => featureId
  });
  const taskTools = buildFeatureTaskTools({
    agentStore, featuresStore: features, workStore: workItems, sse, wakeScheduler
  });
  const taskComplete = taskTools.find((t) => t.name === "task_complete")!;

  // 3. Seed an agent_task with overview as caller
  const task = agentStore.createTask({
    featureId,
    threadId: featureThread.id,
    source: "agent",
    channel: "manager",
    title: "build login",
    message: "build login",
    priority: 0,
    callerThreadId: overview.id,
    createdByThreadId: overview.id
  });

  const ctx = { threadId: featureThread.id, wakeId: "fw", scope: {} } as any;

  // 4. Two passive phase updates via update_my_work_item — no wake expected
  await updateMyItem.handler({ phase: "working", phaseDetail: "dispatching codex" }, ctx);
  await updateMyItem.handler({ phase: "verifying", phaseDetail: "running e2e" }, ctx);

  // 5. task_complete (no notifyUser — param removed)
  const completeResult = await taskComplete.handler(
    { taskId: task.id, summary: "login flow shipped + tests" },
    ctx
  );
  expect(completeResult).not.toHaveProperty("error");

  // --- Assertions ---

  // agent_task is marked done
  expect(agentStore.getTaskById(task.id)?.status).toBe("done");

  // task_complete leaves phase / summary alone (set by update_my_work_item),
  // but auto-bumps needsUser to 'review' so the user notices.
  const finalItem = workItems.getByFeature(featureId)!;
  expect(finalItem.phase).toBe("verifying"); // last set by update_my_work_item
  expect(finalItem.needsUser).toBe("review"); // auto-bumped on task_complete

  // task_complete wakes the caller (overview) exactly once with a completion event.
  const overviewWakes = wakeCalls.filter((args) => args[0] === overview.id);
  expect(overviewWakes.length).toBe(1);

  // One feature_event mailbox row queued for overview thread (kind=completion).
  const evRows = db.prepare(
    "select count(*) as n from agent_mailbox where thread_id = ? and event_kind = 'feature_event'"
  ).get(overview.id) as { n: number };
  expect(evRows.n).toBe(1);

  // No agent_messages written to overview thread (no message-style events).
  const msgRows = db.prepare(
    "select count(*) as n from agent_messages where thread_id = ?"
  ).get(overview.id) as { n: number };
  expect(msgRows.n).toBe(0);
});

test("scenario A2: agent sets phase=done + summary; needsUser stays review", async () => {
  // Canonical flow: task_complete closes the queue item; update_my_work_item
  // moves phase to 'done' and writes a summary. The feature agent does not
  // clear the review flag; overview / user owns that decision.
  const { features, workItems, agentStore, overview, wakeScheduler, sse, projectId } = setup();

  const featureId = features.insert({
    projectId, name: "checkout", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "checkout", ownership: "app"
  });
  // task_complete requires a bound canvas for overview-dispatched main work.
  workItems.setCanvasIdForFeature(featureId, "canvas_stub");
  const featureThread = agentStore.getOrCreateThread("worker", featureId);

  const updateMyItem = buildFeatureWorkItemTool({
    workStore: workItems, sse, resolveFeatureId: () => featureId
  });
  const taskTools = buildFeatureTaskTools({
    agentStore, featuresStore: features, workStore: workItems, sse, wakeScheduler
  });
  const taskComplete = taskTools.find((t) => t.name === "task_complete")!;

  const task = agentStore.createTask({
    featureId,
    threadId: featureThread.id,
    source: "agent",
    channel: "manager",
    title: "checkout",
    message: "checkout",
    priority: 0,
    callerThreadId: overview.id,
    createdByThreadId: overview.id
  });

  const ctx = { threadId: featureThread.id, wakeId: "fw", scope: {} } as any;

  // Initial needsUser is null (default idle state).
  expect(workItems.getByFeature(featureId)?.needsUser).toBeNull();

  // task_complete on an overview-dispatched task auto-bumps needsUser=review.
  await taskComplete.handler({ taskId: task.id, summary: "checkout done" }, ctx);
  expect(agentStore.getTaskById(task.id)?.status).toBe("done");
  expect(workItems.getByFeature(featureId)?.needsUser).toBe("review");

  // Agent sets phase=done + summary; needsUser stays review.
  await updateMyItem.handler(
    { phase: "done", summary: "checkout shipped" },
    ctx
  );

  const itemFinal = workItems.getByFeature(featureId)!;
  expect(itemFinal.phase).toBe("done");
  expect(itemFinal.summary).toBe("checkout shipped");
  // needsUser stays review — only overview / user can clear it.
  expect(itemFinal.needsUser).toBe("review");
});

test("scenario A3: task_complete rejects when overview-dispatched task has no bound canvas", async () => {
  const { features, workItems, agentStore, overview, wakeScheduler, sse, projectId } = setup();

  const featureId = features.insert({
    projectId, name: "billing", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "billing", ownership: "app"
  });
  // No setCanvasIdForFeature — canvasId stays null.
  const featureThread = agentStore.getOrCreateThread("worker", featureId);

  const taskTools = buildFeatureTaskTools({
    agentStore, featuresStore: features, workStore: workItems, sse, wakeScheduler
  });
  const taskComplete = taskTools.find((t) => t.name === "task_complete")!;
  const task = agentStore.createTask({
    featureId,
    threadId: featureThread.id,
    source: "agent",
    channel: "manager",
    title: "billing",
    message: "billing",
    priority: 0,
    callerThreadId: overview.id,
    createdByThreadId: overview.id
  });

  const ctx = { threadId: featureThread.id, wakeId: "fw", scope: {} } as any;
  const result = await taskComplete.handler(
    { taskId: task.id, summary: "billing done" },
    ctx
  ) as { error?: string };

  expect(result.error).toBeDefined();
  expect(result.error).toContain("canvas_create");
  // Task remains active — not marked done.
  expect(agentStore.getTaskById(task.id)?.status).not.toBe("done");

  // Once a canvas is bound, the same task_complete succeeds.
  workItems.setCanvasIdForFeature(featureId, "canvas_stub");
  const retry = await taskComplete.handler(
    { taskId: task.id, summary: "billing done" },
    ctx
  );
  expect(retry).not.toHaveProperty("error");
  expect(agentStore.getTaskById(task.id)?.status).toBe("done");
});

test("task_complete on a side-task (no callerThreadId) does NOT require a canvas", async () => {
  const { features, workItems, agentStore, wakeScheduler, sse, projectId } = setup();

  const featureId = features.insert({
    projectId, name: "shipping", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "shipping", ownership: "app"
  });
  // No canvas bound, no caller — side-task path.
  const featureThread = agentStore.getOrCreateThread("worker", featureId);

  const taskTools = buildFeatureTaskTools({
    agentStore, featuresStore: features, workStore: workItems, sse, wakeScheduler
  });
  const taskComplete = taskTools.find((t) => t.name === "task_complete")!;
  const task = agentStore.createTask({
    featureId,
    threadId: featureThread.id,
    source: "agent",
    channel: "chat",
    title: "lookup",
    message: "lookup",
    priority: 0,
    callerThreadId: null,
    createdByThreadId: featureThread.id
  });

  const ctx = { threadId: featureThread.id, wakeId: "fw", scope: {} } as any;
  const result = await taskComplete.handler(
    { taskId: task.id, summary: "looked up" },
    ctx
  );
  expect(result).not.toHaveProperty("error");
  expect(agentStore.getTaskById(task.id)?.status).toBe("done");
});
