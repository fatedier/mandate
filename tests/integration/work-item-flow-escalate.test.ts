import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
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

test("scenario B: task_notify_caller(blocked) without workStore only writes mailbox feature_event + overview wake", async () => {
  const { db, features, workItems, agentStore, overview, wakeScheduler, wakeCalls, sse, projectId } = setup();

  // 1. Create feature (auto-creates work_item per T4)
  const featureId = features.insert({
    projectId, name: "search", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "search", ownership: "app"
  });
  const featureThread = agentStore.getOrCreateThread("worker", featureId);

  // Capture initial state before any task tool call
  const itemBefore = workItems.getByFeature(featureId);
  const stateBefore = itemBefore?.needsUser ?? null;

  // 2. Build task tools without workStore to cover the legacy/decoupled wiring.
  const taskTools = buildFeatureTaskTools({
    agentStore, featuresStore: features, sse, wakeScheduler
  });
  const taskNotifyCaller = taskTools.find((t) => t.name === "task_notify_caller")!;

  // 3. Seed an agent_task with overview as caller
  const task = agentStore.createTask({
    featureId,
    threadId: featureThread.id,
    source: "agent",
    channel: "manager",
    title: "implement search",
    message: "implement search",
    priority: 0,
    callerThreadId: overview.id,
    createdByThreadId: overview.id
  });

  const ctx = { threadId: featureThread.id, wakeId: "fw", scope: {} } as any;

  // 4. Feature agent calls task_notify_caller(blocked)
  const result = await taskNotifyCaller.handler({
    taskId: task.id,
    message: "choose A or B",
    kind: "blocked"
  }, ctx);

  expect(result).not.toHaveProperty("error");

  // --- Assertions ---

  // Without workStore in deps, task_notify_caller cannot mark needsUser=input.
  const finalItem = workItems.getByFeature(featureId)!;
  expect(finalItem.needsUser).toBe(stateBefore);

  // The escalation signal never writes phase detail directly.
  expect(finalItem.phaseDetail).toBeNull();

  // Exactly 1 wake call on the overview thread
  const overviewWakes = wakeCalls.filter((args) => args[0] === overview.id);
  expect(overviewWakes.length).toBe(1);

  // agent_mailbox has 1 feature_event row for overview thread
  const mailboxRows = db.prepare(
    "select * from agent_mailbox where thread_id = ? and event_kind = 'feature_event'"
  ).all(overview.id) as any[];
  expect(mailboxRows.length).toBe(1);

  // content.kind === 'escalation', content.signal === 'blocked', content.summary === 'choose A or B'
  const content = JSON.parse(mailboxRows[0].content);
  expect(content.kind).toBe("escalation");
  expect(content.signal).toBe("blocked");
  expect(content.summary).toBe("choose A or B");

  // agent_messages on overview has 0 rows (escalation doesn't drain into chat)
  const msgRows = db.prepare(
    "select count(*) as n from agent_messages where thread_id = ?"
  ).get(overview.id) as { n: number };
  expect(msgRows.n).toBe(0);
});

test("scenario B2: overview triages blocked escalation by setting needsUser=input on work_item", async () => {
  // The overview agent (not task_notify_caller) sets needsUser=input via update_work_item.
  // This test verifies overview can set needsUser independently of the escalation signal.
  const { features, workItems, agentStore, overview, wakeScheduler, sse, projectId } = setup();

  const featureId = features.insert({
    projectId, name: "reports", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "reports", ownership: "app"
  });
  const featureThread = agentStore.getOrCreateThread("worker", featureId);

  const taskTools = buildFeatureTaskTools({
    agentStore, featuresStore: features, sse, wakeScheduler
  });
  const taskNotifyCaller = taskTools.find((t) => t.name === "task_notify_caller")!;

  const task = agentStore.createTask({
    featureId,
    threadId: featureThread.id,
    source: "agent",
    channel: "manager",
    title: "reports",
    message: "reports",
    priority: 0,
    callerThreadId: overview.id,
    createdByThreadId: overview.id
  });

  const ctx = { threadId: featureThread.id, wakeId: "fw", scope: {} } as any;

  // Feature agent escalates — this does NOT set state
  await taskNotifyCaller.handler({ taskId: task.id, message: "need decision", kind: "blocked" }, ctx);

  const itemAfterEscalation = workItems.getByFeature(featureId)!;
  expect(itemAfterEscalation.needsUser).toBeNull(); // unchanged

  // Overview now triages: sets needsUser=input on the work_item directly
  workItems.update(itemAfterEscalation.id, { needsUser: "input" });

  const itemAfterTriage = workItems.getByFeature(featureId)!;
  expect(itemAfterTriage.needsUser).toBe("input");

  // And listAttention now includes the item
  const attention = workItems.listAttention({ limit: 100 });
  expect(attention.some((i) => i.id === itemAfterTriage.id)).toBe(true);
});
