import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { buildFeatureTaskTools } from "../src/server/modules/agent/tools/feature-task-tools.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);

  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const agentStore = new AgentStore(db);
  const workItems = new WorkItemStore(db);

  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p", isGit: false,
    gitRemote: null, ownership: "app"
  });
  const featureId = features.insert({
    projectId, name: "login", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "login", ownership: "app"
  });

  const callerThread = agentStore.getOrCreateThread("manager", null);
  const featureThread = agentStore.getOrCreateThread("worker", featureId);

  return { db, projects, features, agentStore, workItems, projectId, featureId, callerThread, featureThread };
}

function buildDeps(env: ReturnType<typeof setup>, wakeStub: { wake: (...args: any[]) => any }) {
  return {
    agentStore: env.agentStore,
    featuresStore: env.features,
    sse: { emit: () => {} } as any,
    wakeScheduler: {
      wake: wakeStub.wake,
      getRunningWakeForThread: () => null
    }
  };
}

function seedTask(env: ReturnType<typeof setup>) {
  return env.agentStore.createTask({
    featureId: env.featureId,
    threadId: env.featureThread.id,
    source: "agent",
    channel: "manager",
    title: "Do work",
    message: "Do work",
    callerThreadId: env.callerThread.id,
    createdByThreadId: env.callerThread.id
  });
}

function getCompleteTool(deps: ReturnType<typeof buildDeps>) {
  return buildFeatureTaskTools(deps).find((t) => t.name === "task_complete")!;
}

test("task_complete marks agent_task done, no work_item side effect", async () => {
  const env = setup();
  const wakeCalls: any[] = [];
  const deps = buildDeps(env, { wake: (...args: any[]) => { wakeCalls.push(args); return "w1"; } });
  const task = seedTask(env);
  const tool = getCompleteTool(deps);

  const result = await tool.handler(
    { taskId: task.id, summary: "All done" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  );

  expect(result).not.toHaveProperty("error");

  // agent_task is marked done
  expect(env.agentStore.getTaskById(task.id)?.status).toBe("done");

  // work_item needsUser is NOT touched when workStore is not in deps.
  const workItem = env.workItems.getByFeature(env.featureId);
  if (workItem) {
    expect(workItem.needsUser).toBeNull();
  }

  // Caller IS woken: task has callerThreadId so a completion event is sent.
  expect(wakeCalls.filter((c) => c[0] === env.callerThread.id)).toHaveLength(1);
  expect(env.agentStore.hasQueuedFeatureEvents(env.callerThread.id)).toBe(true);
});

test("task_complete wakes caller and returns notifiedCaller=true when callerThreadId is set", async () => {
  const env = setup();
  const deps = buildDeps(env, { wake: () => "w1" });
  const task = seedTask(env);
  const tool = getCompleteTool(deps);

  const result = await tool.handler(
    { taskId: task.id, summary: "summary" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  ) as any;

  expect(result.ok).toBe(true);
  expect(result.notifiedCaller).toBe(true);
  expect(result.callerWakeId).toBe("w1");
});

test("task_complete on side-task (no caller) does not wake anyone", async () => {
  const env = setup();
  const wakeCalls: any[] = [];
  const deps = buildDeps(env, { wake: (...args: any[]) => { wakeCalls.push(args); return "w1"; } });
  // task without callerThreadId — represents a side-task / non-dispatched work
  const task = env.agentStore.createTask({
    featureId: env.featureId,
    threadId: env.featureThread.id,
    source: "agent",
    channel: "chat",
    title: "Lookup something",
    message: "Lookup something",
    callerThreadId: null,
    createdByThreadId: env.featureThread.id
  });
  const tool = getCompleteTool(deps);

  const result = await tool.handler(
    { taskId: task.id, summary: "result" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  ) as any;

  expect(result.ok).toBe(true);
  expect(result.notifiedCaller).toBeUndefined();
  expect(wakeCalls).toHaveLength(0);
  expect(env.agentStore.hasQueuedMailboxMessages(env.callerThread.id)).toBe(false);
});

test("task_complete summary stored in lastNote", async () => {
  const env = setup();
  const deps = buildDeps(env, { wake: () => "w1" });
  const task = seedTask(env);
  const tool = getCompleteTool(deps);

  await tool.handler(
    { taskId: task.id, summary: "work complete, tests pass" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  );

  const updated = env.agentStore.getTaskById(task.id);
  expect(updated?.lastNote).toBe("work complete, tests pass");
});

test("task_complete returns a minimal { ok, completedAt } payload", async () => {
  const env = setup();
  const deps = buildDeps(env, { wake: () => "w1" });
  const task = seedTask(env);
  const tool = getCompleteTool(deps);

  const result = await tool.handler(
    { taskId: task.id, summary: "done" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  ) as any;

  expect(result.ok).toBe(true);
  expect(typeof result.completedAt).toBe("string");
  // bloated fields removed
  expect(result.task).toBeUndefined();
});
