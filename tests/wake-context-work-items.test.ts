import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { buildWorkItemWakeSection } from "../src/server/modules/agent/wake-work-items-context.js";

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
  const projectId = projects.insert({
    name: "p",
    workingDir: "/tmp/p",
    tmuxSessionName: "p",
    isGit: false,
    gitRemote: null,
    ownership: "app"
  });
  return { db, projects, features, workItems, agentStore, overview, projectId };
}

test("renders three sections in order: attention, fyi, incoming events", () => {
  const { features, workItems, agentStore, overview, projectId } = setup();

  // feat-A: needs user input
  const fA = features.insert({
    projectId,
    name: "feat-a",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "a",
    ownership: "app"
  });
  const itemA = workItems.getByFeature(fA)!;
  workItems.update(itemA.id, { needsUser: "input", phaseDetail: "blocked on X" });

  // feat-B: passive recent work
  const fB = features.insert({
    projectId,
    name: "feat-b",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "b",
    ownership: "app"
  });
  workItems.update(workItems.getByFeature(fB)!.id, { phaseDetail: "running e2e" });

  // incoming escalation event
  agentStore.enqueueMailboxEvent({
    threadId: overview.id,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t",
      featureId: fA,
      workItemId: itemA.id,
      label: "A",
      summary: "pick A or B",
      signal: "blocked"
    }
  });

  const { text, processedEventIds } = buildWorkItemWakeSection(
    overview.id,
    workItems,
    agentStore
  );

  expect(text).toContain("--- OPEN WORK ITEMS NEEDING ATTENTION ---");
  expect(text).toContain("needsUser=input");
  expect(text).toContain("blocked on X");
  expect(text).toContain("--- RECENT PASSIVE UPDATES (FYI, no action needed) ---");
  expect(text).toContain("running e2e");
  expect(text).toContain("--- INCOMING FEATURE EVENTS THIS WAKE ---");
  expect(text).toContain("signal=blocked");
  expect(text).toContain("pick A or B");

  // section order
  const idxAttention = text.indexOf("OPEN WORK ITEMS NEEDING ATTENTION");
  const idxFyi = text.indexOf("RECENT PASSIVE UPDATES");
  const idxEvents = text.indexOf("INCOMING FEATURE EVENTS");
  expect(idxAttention).toBeLessThan(idxFyi);
  expect(idxFyi).toBeLessThan(idxEvents);

  // processed lists
  expect(processedEventIds.length).toBe(1);
});

test("limit_reached feature events include continuation guidance", () => {
  const { features, workItems, agentStore, overview, projectId } = setup();
  const featureId = features.insert({
    projectId,
    name: "feat-limit",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "limit",
    ownership: "app"
  });
  const workItem = workItems.getByFeature(featureId)!;

  agentStore.enqueueMailboxEvent({
    threadId: overview.id,
    role: "user",
    source: "feature-event",
    sourceThreadId: "feature-thread",
    content: {
      type: "feature_event",
      kind: "limit_reached",
      featureId,
      workItemId: workItem.id,
      label: "Long feature wake",
      summary: "Final summary from the feature agent.",
      stepCount: 201
    }
  });

  const { text } = buildWorkItemWakeSection(overview.id, workItems, agentStore);

  expect(text).toContain("kind=limit_reached");
  expect(text).toContain("stepCount=201");
  expect(text).toContain("Final summary from the feature agent.");
  expect(text).toContain("feature-level wake limit");
  expect(text).toContain("feature_message_send");
  expect(text).not.toContain("task=task-limit");
});


test("attention section sorts input before review", () => {
  const { features, workItems, agentStore, overview, projectId } = setup();

  const fA = features.insert({
    projectId,
    name: "a",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "a",
    ownership: "app"
  });
  const fB = features.insert({
    projectId,
    name: "b",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "b",
    ownership: "app"
  });
  workItems.update(workItems.getByFeature(fA)!.id, { needsUser: "review" });
  workItems.update(workItems.getByFeature(fB)!.id, { needsUser: "input" });

  const { text } = buildWorkItemWakeSection(overview.id, workItems, agentStore);
  const idxA = text.indexOf("needsUser=review");
  const idxB = text.indexOf("needsUser=input");
  expect(idxB).toBeLessThan(idxA);
});

test("empty sections render '(none)' placeholders", () => {
  const { workItems, agentStore, overview } = setup();
  const { text } = buildWorkItemWakeSection(overview.id, workItems, agentStore);
  expect(text).toContain("OPEN WORK ITEMS NEEDING ATTENTION");
  expect(text).toContain("(none)");
  expect(text).toContain("(none in last 24h)");
});

test("passive item NOT in attention section, IS in fyi", () => {
  const { features, workItems, agentStore, overview, projectId } = setup();

  const f = features.insert({
    projectId,
    name: "p",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "p",
    ownership: "app"
  });
  workItems.update(workItems.getByFeature(f)!.id, { phaseDetail: "in progress" });

  const { text } = buildWorkItemWakeSection(overview.id, workItems, agentStore);

  // attention block should have (none)
  const attentionBlock = text.substring(
    text.indexOf("OPEN WORK ITEMS NEEDING ATTENTION"),
    text.indexOf("RECENT PASSIVE UPDATES")
  );
  expect(attentionBlock).toContain("(none)");
  expect(text).toContain("in progress");
});

test("attention items capped at limit=30 with overflow indicator", () => {
  const { features, workItems, agentStore, overview, projectId } = setup();

  // Create 35 features and flag each for review so they all appear in attention.
  for (let i = 0; i < 35; i++) {
    const fId = features.insert({
      projectId,
      name: `feat-${i}`,
      mode: "shared-cwd",
      branch: null,
      baseRef: null,
      worktreePath: null,
      tmuxWindowName: `w${i}`,
      ownership: "app"
    });
    workItems.update(workItems.getByFeature(fId)!.id, { needsUser: "review" });
  }

  const { text } = buildWorkItemWakeSection(overview.id, workItems, agentStore);

  // Should contain the overflow indicator
  expect(text).toContain("and 5 more attention items not shown");

  // Count occurrences of "needsUser=review" — should be exactly 30
  const matches = text.match(/needsUser=review/g) ?? [];
  expect(matches.length).toBe(30);
});
