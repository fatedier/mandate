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
  const workStore = new WorkItemStore(db);

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

  return { db, projects, features, agentStore, workStore, projectId, featureId, callerThread, featureThread };
}

function buildDeps(env: ReturnType<typeof setup>, wakeStub: { wake: (...args: any[]) => any }) {
  return {
    agentStore: env.agentStore,
    featuresStore: env.features,
    workStore: env.workStore,
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

function getNotifyTool(deps: ReturnType<typeof buildDeps>) {
  return buildFeatureTaskTools(deps).find((t) => t.name === "task_notify_caller")!;
}

test("task_notify_caller(info) updates agent_task.lastNote, does NOT touch work_item", async () => {
  const env = setup();
  const wakeCalls: any[] = [];
  const deps = buildDeps(env, { wake: (...args: any[]) => { wakeCalls.push(args); return "w1"; } });
  const task = seedTask(env);
  const tool = getNotifyTool(deps);

  const result = await tool.handler(
    { taskId: task.id, message: "Making progress on login", kind: "info" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  );

  expect(result).not.toHaveProperty("error");
  expect((result as any).ok).toBe(true);

  // agent_task.lastNote updated
  expect(env.agentStore.getTaskById(task.id)?.lastNote).toBe("Making progress on login");

  // work_item phaseDetail is NOT updated
  const workItem = env.workStore.getByFeature(env.featureId);
  if (workItem) {
    expect(workItem.phaseDetail).toBeNull();
  }

  // needsUser is unchanged
  if (workItem) {
    expect(workItem.needsUser).toBeNull();
  }

  // wakeScheduler.wake NOT called
  expect(wakeCalls.filter((c) => c[0] === env.callerThread.id)).toHaveLength(0);

  // no new mailbox row to overview thread
  const rows = env.db.prepare("select * from agent_mailbox where thread_id = ?").all(env.callerThread.id) as any[];
  expect(rows).toHaveLength(0);
});

test("task_notify_caller(progress) updates agent_task.lastNote only, no work_item touch", async () => {
  const env = setup();
  const wakeCalls: any[] = [];
  const deps = buildDeps(env, { wake: (...args: any[]) => { wakeCalls.push(args); return "w1"; } });
  const task = seedTask(env);
  const tool = getNotifyTool(deps);

  const result = await tool.handler(
    { taskId: task.id, message: "50% done", kind: "progress" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  );

  expect(result).not.toHaveProperty("error");
  expect((result as any).ok).toBe(true);

  // agent_task.lastNote updated
  expect(env.agentStore.getTaskById(task.id)?.lastNote).toBe("50% done");

  // work_item NOT touched
  const workItem = env.workStore.getByFeature(env.featureId);
  if (workItem) {
    expect(workItem.phaseDetail).toBeNull();
    expect(workItem.needsUser).toBeNull();
  }

  expect(wakeCalls.filter((c) => c[0] === env.callerThread.id)).toHaveLength(0);

  const rows = env.db.prepare("select * from agent_mailbox where thread_id = ?").all(env.callerThread.id) as any[];
  expect(rows).toHaveLength(0);
});

test("task_notify_caller(blocked) writes escalation, wakes, and marks work_item input-needed", async () => {
  const env = setup();
  const wakeCalls: any[] = [];
  const deps = buildDeps(env, { wake: (...args: any[]) => { wakeCalls.push(args); return "w1"; } });
  const task = seedTask(env);
  const tool = getNotifyTool(deps);

  const result = await tool.handler(
    { taskId: task.id, message: "Need approval to proceed", kind: "blocked" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  );

  expect(result).not.toHaveProperty("error");
  expect((result as any).notifiedCaller).toBe(true);
  expect((result as any).callerWakeId).toBe("w1");

  const workItem = env.workStore.getByFeature(env.featureId);
  expect(workItem?.needsUser).toBe("input");
  expect(workItem?.phaseDetail).toBeNull();

  // mailbox row written to caller thread with escalation content
  const rows = env.db.prepare("select * from agent_mailbox where thread_id = ?").all(env.callerThread.id) as any[];
  expect(rows).toHaveLength(1);
  const content = JSON.parse(rows[0].content);
  expect(content.kind).toBe("escalation");
  expect(content.signal).toBe("blocked");
  expect(content.summary).toBe("Need approval to proceed");

  // wakeScheduler.wake called once for the caller/overview thread
  expect(wakeCalls.filter((c) => c[0] === env.callerThread.id)).toHaveLength(1);
});

test("task_notify_caller(needs_user) escalates via mailbox, wakes, and marks work_item input-needed", async () => {
  const env = setup();
  const wakeCalls: any[] = [];
  const deps = buildDeps(env, { wake: (...args: any[]) => { wakeCalls.push(args); return "w2"; } });
  const task = seedTask(env);
  const tool = getNotifyTool(deps);

  const result = await tool.handler(
    { taskId: task.id, message: "Waiting for user input", kind: "needs_user" },
    { threadId: env.featureThread.id, wakeId: "fw", scope: {} } as any
  );

  expect(result).not.toHaveProperty("error");
  expect((result as any).notifiedCaller).toBe(true);
  expect((result as any).callerWakeId).toBe("w2");

  const workItem = env.workStore.getByFeature(env.featureId);
  expect(workItem?.needsUser).toBe("input");
  expect(workItem?.phaseDetail).toBeNull();

  // mailbox row with signal=needs_user
  const rows = env.db.prepare("select * from agent_mailbox where thread_id = ?").all(env.callerThread.id) as any[];
  expect(rows).toHaveLength(1);
  const content = JSON.parse(rows[0].content);
  expect(content.kind).toBe("escalation");
  expect(content.signal).toBe("needs_user");
  expect(content.summary).toBe("Waiting for user input");

  expect(wakeCalls.filter((c) => c[0] === env.callerThread.id)).toHaveLength(1);
});
