import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { buildWorkItemWakeSection } from "../src/server/modules/agent/wake-work-items-context.js";
import type { AgentWakeReason } from "../src/server/modules/agent/agent-store.js";

const SWEEP_HEADER = "--- SWEEP: NOT DONE, AND NOTHING WILL WAKE THESE ---";

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
  return { db, features, workItems, agentStore, overview, projectId };
}

function stalledFeature(s: ReturnType<typeof setup>, name: string): string {
  const featureId = s.features.insert({
    projectId: s.projectId,
    name,
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: name,
    ownership: "app"
  });
  s.agentStore.getOrCreateThread("worker", featureId);
  return featureId;
}

/** Render the wake context as it would look on a wake with this reason. */
function render(s: ReturnType<typeof setup>, reason: AgentWakeReason): string {
  s.agentStore.createWake({ threadId: s.overview.id, reason, triggerMessageId: null });
  return buildWorkItemWakeSection(s.overview.id, s.workItems, s.agentStore).text;
}

describe("the sweep section is gated on the wake that asked for it", () => {
  test("appears on a sweep wake", () => {
    const s = setup();
    const featureId = stalledFeature(s, "stuck");
    const text = render(s, "work-item-heartbeat");

    expect(text).toContain(SWEEP_HEADER);
    expect(text).toContain(featureId);
  });

  test("is absent on a user wake, even with the same stalled feature", () => {
    // Every other wake arrives with its own errand. Handing it the standing
    // list as well is how a list stops being read.
    const s = setup();
    stalledFeature(s, "stuck");
    expect(render(s, "user")).not.toContain(SWEEP_HEADER);
  });

  test("retains the interrupted sweep context when a new user message also triggers recovery", () => {
    const s = setup();
    try {
      const featureId = stalledFeature(s, "recovering");
      render(s, "work-item-heartbeat");
      s.agentStore.recoverInterruptedWakes("restart");
      s.agentStore.createWake({ threadId: s.overview.id, reason: "user", triggerMessageId: "latest-input" });
      const text = buildWorkItemWakeSection(s.overview.id, s.workItems, s.agentStore).text;
      expect(text).toContain(SWEEP_HEADER);
      expect(text).toContain(featureId);
    } finally { s.db.close(); }
  });

  test("is absent on a feature-event wake", () => {
    const s = setup();
    stalledFeature(s, "stuck");
    expect(render(s, "feature-event")).not.toContain(SWEEP_HEADER);
  });

  test("is absent when no wake is running", () => {
    const s = setup();
    stalledFeature(s, "stuck");
    const text = buildWorkItemWakeSection(s.overview.id, s.workItems, s.agentStore).text;
    expect(text).not.toContain(SWEEP_HEADER);
  });
});

describe("what the sweep section says", () => {
  test("names the section and tells the agent it may end the sweep", () => {
    const s = setup();
    stalledFeature(s, "stuck");
    const text = render(s, "work-item-heartbeat");

    expect(text).toContain(SWEEP_HEADER);
    expect(text).toContain("end_sweep");
    expect(text).toContain("no running wake · no pending alarm");
  });

  test("still renders with nothing stalled, and says so", () => {
    // The empty sweep is the one that ends the loop: the agent has to be told
    // it looked and found nothing, or it has no reason to call end_sweep.
    const s = setup();
    const text = render(s, "work-item-heartbeat");

    expect(text).toContain(SWEEP_HEADER);
    expect(text).toContain("(none)");
    expect(text).toContain("end_sweep");
  });

  test("a stalled feature does not also appear as passive FYI", () => {
    // It is fresh enough for listIdle's 24h window, so without care it would be
    // listed twice — once as needing action, once under "no action needed".
    const s = setup();
    const featureId = stalledFeature(s, "stuck");
    const text = render(s, "work-item-heartbeat");

    const fyi = text.slice(
      text.indexOf("--- RECENT PASSIVE UPDATES"),
      text.indexOf(SWEEP_HEADER)
    );
    expect(fyi).not.toContain(featureId);
  });

  test("the three original sections still render in order", () => {
    const s = setup();
    const text = render(s, "work-item-heartbeat");
    const order = [
      "--- OPEN WORK ITEMS NEEDING ATTENTION ---",
      "--- RECENT PASSIVE UPDATES (FYI, no action needed) ---",
      SWEEP_HEADER,
      "--- INCOMING FEATURE EVENTS THIS WAKE ---"
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
