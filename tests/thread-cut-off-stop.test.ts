import { expect, test } from "bun:test";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { reportWorkerWakeEnd, wakeEndStatus } from "../src/server/runtime/worker-report.js";
import { workerReportOf } from "../src/shared/worker-report.js";
import { WAKE_FAILURE_STATUS_SQL, type AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { WakeFailureContent } from "../src/shared/agent-message-types.js";
import { recordingInbox } from "./helpers/upward-inbox.js";

/** A wake of `threadId` that ended as the wake loop ends it: its row, and the
 *  failure row a cut-off, a stop or an error leaves. */
function endedWake(agentStore: AgentStore, threadId: string, status: "finished" | "stuck" | "error", failure: Omit<WakeFailureContent, "type"> | null, errorMessage: string | null = null): string {
  const wake = agentStore.createWake({ threadId, reason: "user", triggerMessageId: null });
  if (failure) {
    agentStore.appendMessage({ threadId, role: "system", source: "wake-failure", wakeId: wake.id, content: { type: "wake_failure", ...failure } });
  }
  agentStore.finishWake(wake.id, status, errorMessage);
  return wake.id;
}

const CUT_OFF = { status: "cut_off" as const, message: "Cut off at the output token limit.", stepCount: 3 };

test("a manager turn stopped by cut-offs reads failed, with the stop line as its reason", () => {
  const e = freshStoresEnv("md-cutoff-mgr-");
  try {
    const manager = e.agentStore.createManagerThread("Release notes");
    endedWake(e.agentStore, manager.id, "finished", CUT_OFF);
    const dto = new ManagerThreadService({ agentStore: e.agentStore }).dto(manager.id)!;
    expect(dto.failed).toBe(true);
    expect(dto.stopReason).toBe("Cut off at the output token limit.");
  } finally {
    e.cleanup();
  }
});

test("a turn that finished cleanly after an earlier cut-off reads as it is", () => {
  const e = freshStoresEnv("md-cutoff-later-");
  try {
    const manager = e.agentStore.createManagerThread("Release notes");
    endedWake(e.agentStore, manager.id, "finished", CUT_OFF);
    endedWake(e.agentStore, manager.id, "finished", null);
    const dto = new ManagerThreadService({ agentStore: e.agentStore }).dto(manager.id)!;
    expect(dto.failed).toBe(false);
    expect(dto.stopReason).toBe(null);
  } finally {
    e.cleanup();
  }
});

test("a finished wake with a cut-off row ends as cut_off; other ends keep their status", () => {
  const e = freshStoresEnv("md-cutoff-status-");
  try {
    const manager = e.agentStore.createManagerThread("Release notes");
    const cut = endedWake(e.agentStore, manager.id, "finished", CUT_OFF);
    const clean = endedWake(e.agentStore, manager.id, "finished", null);
    const stuck = endedWake(e.agentStore, manager.id, "stuck", { status: "stuck", message: "same call", stepCount: 5 }, "same call");
    expect(wakeEndStatus(e.agentStore, cut, "finished")).toBe("cut_off");
    expect(wakeEndStatus(e.agentStore, clean, "finished")).toBe("finished");
    expect(wakeEndStatus(e.agentStore, stuck, "stuck")).toBe("stuck");
    expect(wakeEndStatus(e.agentStore, cut, "canceled")).toBe("canceled");
  } finally {
    e.cleanup();
  }
});

test("a worker wake stopped by cut-offs is recorded as stopped and reported to its manager", () => {
  const e = freshStoresEnv("md-cutoff-worker-");
  try {
    const projectId = seedProject(e.projects, { name: "project-1" });
    const featureId = seedFeature(e.features, projectId, { name: "docs pass" });
    const workStore = new WorkItemStore(e.store.db);
    const planStore = new PlanStore(e.store.db);
    const workerThread = e.agentStore.getOrCreateThread("worker", featureId);
    const manager = e.agentStore.createManagerThread("General");
    e.features.setOwner(featureId, manager.id);
    planStore.update(featureId, { steps: [{ title: "Write", status: "in_progress" }] });
    const deps = {
      agentStore: e.agentStore, featuresStore: e.features, projectsStore: e.projects, workStore, planStore,
      inbox: recordingInbox(e.agentStore).inbox, now: () => "2026-09-27T12:00:00.000Z"
    };
    const report = reportWorkerWakeEnd(deps, { threadId: workerThread.id, status: "cut_off", errorMessage: null });
    const item = workStore.getByFeature(featureId)!;
    expect(item.failedKind).toBe("stopped");
    expect(item.failedMessage).toBe("Cut off at the output token limit.");
    expect(report?.key).toBe("stopped");
    const row = e.store.db.prepare("select content from agent_mailbox where source = 'worker-report'").get() as { content: string };
    expect(workerReportOf(JSON.parse(row.content))?.line).toBe("Cut off at the output token limit.");
  } finally {
    e.cleanup();
  }
});

test("the failure lookup reads a failure-only index, and one DTO looks once", () => {
  const e = freshStoresEnv("md-cutoff-index-");
  try {
    const plan = e.store.db.prepare(`explain query plan ${WAKE_FAILURE_STATUS_SQL}`).all("wk_x") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("idx_agent_messages_wake_failure");
    const manager = e.agentStore.createManagerThread("Release notes");
    endedWake(e.agentStore, manager.id, "finished", CUT_OFF);
    let lookups = 0;
    const real = e.agentStore.wakeFailureStatus.bind(e.agentStore);
    e.agentStore.wakeFailureStatus = (wakeId) => { lookups++; return real(wakeId); };
    new ManagerThreadService({ agentStore: e.agentStore }).dto(manager.id);
    expect(lookups).toBe(1);
  } finally {
    e.cleanup();
  }
});
