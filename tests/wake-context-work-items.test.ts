import { describe, expect, spyOn, test } from "bun:test";
import { answersMetadata } from "../src/shared/questions.js";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeWorkersSchema } from "../src/server/modules/workers/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { initializePlansSchema } from "../src/server/modules/plans/schema.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { AgentStore, type AgentWakeReason } from "../src/server/modules/agent/agent-store.js";
import { buildWorkItemWakeSection } from "../src/server/modules/agent/wake-work-items-context.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import type { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { stub } from "./helpers/typed.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";
import { onCleanup } from "./helpers/cleanup.js";

/** Every worker made here is the manager's, as a create makes a worker its
 *  maker's. */
class ManagersWorkers extends WorkersStore {
  owner: string | null = null;
  override insert(input: Parameters<WorkersStore["insert"]>[0]): string {
    return super.insert({ ...input, ownerThreadId: input.ownerThreadId ?? this.owner });
  }
}

function setup() {
  const db = new Database(":memory:");
  onCleanup(() => db.close());
  initializeProjectsSchema(db);
  initializeWorkersSchema(db);
  initializePlansSchema(db);
  initializeAgentSchema(db);
  const plans = new PlanStore(db);
  const projects = new ProjectsStore(db);
  const workers = new ManagersWorkers(db);
  const workItems = new WorkItemStore(db);
  const agentStore = new AgentStore(db);
  const manager = agentStore.getOrCreateThread("manager", null);
  workers.owner = manager.id;
  const projectId = seedProject(projects, { name: "p", workingDir: "/tmp/p", tmuxSessionName: "p" });
  return { db, projects, workers, workItems, agentStore, manager, projectId, plans };
}

test("renders two sections in order: attention, fyi", () => {
  const { workers, workItems, agentStore, manager, projectId, plans } = setup();

  // wkr-A: asks a question through its plan
  const fA = workers.insert({
    projectId,
    name: "wkr-a",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "a",
    ownership: "app"
  });
  plans.update(fA, { conclusion: "blocked on X", openQuestions: ["Go ahead without X?"] });

  // wkr-B: passive recent work
  const fB = workers.insert({
    projectId,
    name: "wkr-b",
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: "b",
    ownership: "app"
  });
  workItems.touch(workItems.getByWorker(fB)!.id);
  plans.update(fB, { conclusion: "running e2e", steps: [{ title: "e2e", status: "in_progress" }] });

  const text = buildWorkItemWakeSection(
    manager.id,
    workItems,
    agentStore,
    plans
  );

  expect(text).toContain("--- OPEN WORK ITEMS NEEDING ATTENTION ---");
  expect(text).toContain("· open questions]");
  expect(text).toContain("  - Go ahead without X?");
  expect(text).toContain("blocked on X");
  expect(text).toContain("--- RECENT PASSIVE UPDATES (FYI, no action needed) ---");
  expect(text).toContain("running e2e");
  expect(text).toContain("In progress · 0/1] running e2e — now #1: e2e");

  // section order
  const idxAttention = text.indexOf("OPEN WORK ITEMS NEEDING ATTENTION");
  const idxFyi = text.indexOf("RECENT PASSIVE UPDATES");
  expect(idxAttention).toBeLessThan(idxFyi);
});

test("empty sections render '(none)' placeholders", () => {
  const { workItems, agentStore, manager } = setup();
  const text = buildWorkItemWakeSection(manager.id, workItems, agentStore);
  expect(text).toBe([
    "--- OPEN WORK ITEMS NEEDING ATTENTION ---",
    "(none)",
    "",
    "--- YOUR QUESTIONS TO THE USER (NOT ANSWERED YET) ---",
    "(none)",
    "",
    "--- RECENT PASSIVE UPDATES (FYI, no action needed) ---",
    "(none in last 24h)"
  ].join("\n"));
});

test("a worker whose plan asks something is in the attention section, not FYI, though nothing flags it", () => {
  const { workers, workItems, agentStore, manager, projectId, plans } = setup();
  const f = workers.insert({
    projectId, name: "asks", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "asks", ownership: "app"
  });
  const item = workItems.getByWorker(f)!;
  workItems.touch(item.id);
  plans.update(f, { conclusion: "plugin ready", openQuestions: ["Split the cache into its own PR?"] });
  const quiet = workers.insert({
    projectId, name: "quiet", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "quiet", ownership: "app"
  });
  workItems.touch(workItems.getByWorker(quiet)!.id);
  plans.update(quiet, { conclusion: "nothing to ask" });

  const text = buildWorkItemWakeSection(manager.id, workItems, agentStore, plans);
  const attention = text.substring(text.indexOf("OPEN WORK ITEMS NEEDING ATTENTION"), text.indexOf("RECENT PASSIVE UPDATES"));
  const fyi = text.substring(text.indexOf("RECENT PASSIVE UPDATES"));
  expect(attention).toContain(`[${item.id} · ${projectId}/${f} · open questions]`);
  expect(attention).toContain("- Split the cache into its own PR?");
  expect(attention).not.toContain("nothing to ask");
  expect(fyi).not.toContain(item.id);
  expect(fyi).toContain("nothing to ask");
});

// A failed worker is under attention; its recent work would list it as a
// passive update too.
test("a failed worker is under attention with its plan's line, and is not a passive update", () => {
  const { workers, workItems, agentStore, manager, projectId, plans } = setup();
  const f = workers.insert({
    projectId, name: "flagged", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "flagged", ownership: "app"
  });
  const item = workItems.getByWorker(f)!;
  workItems.touch(item.id);
  workItems.setFailure(f, { at: "2026-09-27T12:00:00.000Z", message: "provider returned 500", kind: "error" });
  plans.update(f, { conclusion: "half way", steps: [{ title: "Ship", status: "in_progress" }] });
  const text = buildWorkItemWakeSection(manager.id, workItems, agentStore, plans);
  const attention = text.substring(text.indexOf("OPEN WORK ITEMS NEEDING ATTENTION"), text.indexOf("RECENT PASSIVE UPDATES"));
  const fyi = text.substring(text.indexOf("RECENT PASSIVE UPDATES"));
  expect(attention).toContain(`[${item.id} · ${projectId}/${f} · failed]`);
  expect(attention).toContain("[flagged · Failed · 0/1] half way");
  expect(fyi).not.toContain(item.id);
});

test("a worker stopped short is under attention as stopped; an idle one is not", () => {
  const { workers, workItems, agentStore, manager, projectId } = setup();
  const insert = (name: string) => workers.insert({
    projectId, name, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null, tmuxWindowName: name, ownership: "app"
  });
  const stopped = insert("stopped");
  workItems.setFailure(stopped, { at: "2026-09-27T12:00:00.000Z", message: "the same call kept failing", kind: "stopped" });
  const flagged = insert("flagged");
  const text = buildWorkItemWakeSection(manager.id, workItems, agentStore);
  const attention = text.substring(text.indexOf("OPEN WORK ITEMS NEEDING ATTENTION"), text.indexOf("RECENT PASSIVE UPDATES"));
  expect(attention).toContain(`${projectId}/${stopped} · stopped]`);
  expect(attention).not.toContain(flagged);
});

test("the briefing shows each worker as its plan's line, with open questions under attention", () => {
  const { store, projects, workers, agentStore } = freshStoresEnv("md-mgr-plan-");
  const projectId = seedProject(projects, { name: "project-1" });
  const workerId = seedWorker(workers, projectId, { name: "project-2 evict" });
  const workStore = new WorkItemStore(store.db);
  const item = workStore.getByWorker(workerId)!;
  const plans = new PlanStore(store.db);
  plans.update(workerId, { conclusion: "Waiting on upstream", openQuestions: ["Split the plugin PR?"],
    steps: [{ title: "a", status: "done", note: "ok" }, { title: "wait for project-2", status: "blocked", note: "project-2#17" }] });
  const manager = agentStore.getOrCreateThread("manager", null);
  workers.setOwner(workerId, manager.id);
  const text = buildWorkItemWakeSection(manager.id, workStore, agentStore, plans);
  // What the worker asks is its plan's question: no flag is set for it.
  expect(text).toContain(`[${item.title} · Waiting for an answer · 1/2] Waiting on upstream — open question: Split the plugin PR?`);
  expect(text).toContain("  Open questions:\n  - Split the plugin PR?");
  expect(text).not.toContain("phase=");
});

test("attention items capped at limit=30 with overflow indicator", () => {
  const { workers, workItems, agentStore, manager, projectId } = setup();

  // Create 35 workers whose last wake failed, so they all appear in attention.
  for (let i = 0; i < 35; i++) {
    const workerId = workers.insert({
      projectId,
      name: `wkr-${i}`,
      mode: "shared-cwd",
      branch: null,
      baseRef: null,
      worktreePath: null,
      tmuxWindowName: `w${i}`,
      ownership: "app"
    });
    workItems.setFailure(workerId, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
  }

  const text = buildWorkItemWakeSection(manager.id, workItems, agentStore);

  // Should contain the overflow indicator
  expect(text).toContain("and 5 more attention items not shown");

  // Count the attention lines — should be exactly 30
  const matches = text.match(/ · failed\]/g) ?? [];
  expect(matches.length).toBe(30);
});

// A create writes the worker's row, then its owner: without one it is no
// thread's, not every thread's.
test("a worker with no owner is in no thread's context", () => {
  const e = freshStoresEnv("md-wctx-unowned-");
  const projectId = seedProject(e.projects);
  const a = e.agentStore.createManagerThread("A");
  const f = seedWorker(e.workers, projectId, { name: "Ownerless", tmuxWindowName: "ownerless" });
  const workStore = new WorkItemStore(e.store.db);
  workStore.setFailure(f, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
  expect(buildWorkItemWakeSection(a.id, workStore, e.agentStore)).not.toContain(f);
});

test("a thread's runtime context lists only its own workers in every part — index, attention, asking, FYI, its sweep — and counts the rest", async () => {
  const { buildManagerScope } = await import("../src/server/runtime/scopes/manager-scope.js");
  const e = freshStoresEnv("md-wctx-every-part-");
  const projectId = seedProject(e.projects, { name: "project-1" });
  const workStore = new WorkItemStore(e.store.db);
  const planStore = new PlanStore(e.store.db);
  const a = e.agentStore.createManagerThread("A");
  const b = e.agentStore.createManagerThread("B");
  const make = (owner: string, name: string, kind: "attention" | "asking" | "idle" | "stalled") => {
    const id = seedWorker(e.workers, projectId, { name, tmuxWindowName: name });
    e.workers.setOwner(id, owner);
    if (kind === "attention") workStore.setFailure(id, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
    if (kind === "asking") planStore.update(id, { openQuestions: [`Ship ${name}?`] });
    if (kind === "stalled") {
      planStore.update(id, { steps: [{ title: `${name} step` }] });
      e.agentStore.getOrCreateThread("worker", id);
    }
    return id;
  };
  const kinds = ["attention", "asking", "idle", "stalled"] as const;
  const mine = kinds.map((k) => make(a.id, `a-${k}`, k));
  const theirs = kinds.map((k) => make(b.id, `b-${k}`, k));
  // A is running its sweep while B is awake too.
  e.agentStore.createWake({ threadId: a.id, reason: "sweep", triggerMessageId: null });
  e.agentStore.createWake({ threadId: b.id, reason: "user", triggerMessageId: null });
  const scope = buildManagerScope({
    agentStore: e.agentStore, projectsStore: e.projects, workersStore: e.workers, records: new WorkerRecordStore(e.store.db),
    workStore, planStore, skillRegistry: stub<SkillRegistry>()
  });
  const text = (await scope.buildRuntimeContext!(a.id))!;
  // Each of A's workers is where its kind puts it (the worker index above lists them all).
  const part = (from: string, to?: string) => text.substring(text.indexOf(from), to === undefined ? undefined : text.indexOf(to));
  const attention = part("--- OPEN WORK ITEMS NEEDING ATTENTION ---", "--- YOUR QUESTIONS");
  const fyi = part("--- RECENT PASSIVE UPDATES", "--- SWEEP");
  const sweep = part("--- SWEEP");
  expect([attention, attention, fyi, sweep].map((where, i) => where.includes(mine[i]!))).toStrictEqual([true, true, true, true]);
  for (const id of theirs) expect({ id, listed: text.includes(id) }).toEqual({ id, listed: false });
  expect(text).toContain("Workers in other threads: 4");
  // The sweep names A's stalled worker.
  expect(text).toContain("a-stalled");
  // What it cannot move on by itself it puts to the user as a question: there is no flag to raise for that.
  expect(text).toContain("Action guidance: for each — push it forward with message_worker, or put it to the user with ask_user if you cannot. When every one is handled and nothing is outstanding, call end_sweep.");
  expect(text).not.toContain("needsUser: 'input'");
});

// A worker's plan is shown twice in a manager's context — its index line and
// its work-item line — and read once; the plans that ask are found without
// reading any whole plan.
test("a manager's runtime context reads each of its workers' plans once, and no other plan", async () => {
  const { buildManagerScope } = await import("../src/server/runtime/scopes/manager-scope.js");
  const e = freshStoresEnv("md-wctx-plan-reads-");
  const projectId = seedProject(e.projects, { name: "project-1" });
  const workStore = new WorkItemStore(e.store.db);
  const planStore = new PlanStore(e.store.db);
  const a = e.agentStore.createManagerThread("A");
  const b = e.agentStore.createManagerThread("B");
  const make = (owner: string, name: string) => {
    const id = seedWorker(e.workers, projectId, { name, tmuxWindowName: name });
    e.workers.setOwner(id, owner);
    planStore.update(id, { openQuestions: [`Ship ${name}?`] });
    return id;
  };
  const mine = [make(a.id, "a-one"), make(a.id, "a-two")];
  make(b.id, "b-one");
  const scope = buildManagerScope({
    agentStore: e.agentStore, projectsStore: e.projects, workersStore: e.workers, records: new WorkerRecordStore(e.store.db),
    workStore, planStore, skillRegistry: stub<SkillRegistry>()
  });
  const whole = spyOn(planStore, "get");
  const active = spyOn(planStore, "pagePlansOfActive");
  try {
    const text = (await scope.buildRuntimeContext!(a.id))!;
    for (const id of mine) expect(text).toContain(id);
    expect([whole.mock.calls.map(([id]) => id).sort(), active.mock.calls.length]).toEqual([[...mine].sort(), 0]);
  } finally {
    whole.mockRestore();
    active.mockRestore();
  }
});

test("a manager is shown what it asked the user and has no answer to, between what needs attention and the passive updates", () => {
  const { workItems, agentStore, manager } = setup();
  const section = (text: string) => text.slice(text.indexOf("--- YOUR QUESTIONS TO THE USER"), text.indexOf("--- RECENT PASSIVE UPDATES"));
  const none = buildWorkItemWakeSection(manager.id, workItems, agentStore);
  expect(section(none)).toBe("--- YOUR QUESTIONS TO THE USER (NOT ANSWERED YET) ---\n(none)\n\n");
  expect(none.indexOf("OPEN WORK ITEMS NEEDING ATTENTION")).toBeLessThan(none.indexOf("YOUR QUESTIONS TO THE USER"));
  for (const [id, question] of [["q_ab12cd", "Push the branch?\n\nIt is rebased on main."], ["q_ef34gh", "Tag it too?"]] as const) {
    agentStore.appendMessage({
      threadId: manager.id, role: "tool", source: "self",
      content: { type: "tool_result", toolCallId: `c_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options: [] } }
    });
  }
  // Each on one line, with the id that takes it back.
  expect(section(buildWorkItemWakeSection(manager.id, workItems, agentStore))).toBe(
    "--- YOUR QUESTIONS TO THE USER (NOT ANSWERED YET) ---\n[q_ab12cd] Push the branch? It is rebased on main.\n[q_ef34gh] Tag it too?\n\n"
  );
  // Another thread's questions are not this one's.
  const other = agentStore.createManagerThread("Docs");
  expect(section(buildWorkItemWakeSection(other.id, workItems, agentStore))).toContain("(none)");
  agentStore.appendMessage({ threadId: manager.id, role: "user", source: "user", content: { type: "text", text: "Yes to both.", metadata: answersMetadata([{ id: "q_ab12cd", question: "Push the branch?" }, { id: "q_ef34gh", question: "Tag it too?" }]) } });
  expect(section(buildWorkItemWakeSection(manager.id, workItems, agentStore))).toContain("(none)");
});

const SWEEP_HEADER = "--- SWEEP: NOT DONE, AND NOTHING WILL WAKE THESE ---";

function stalledWorker(s: ReturnType<typeof setup>, name: string): string {
  const workerId = s.workers.insert({
    projectId: s.projectId,
    name,
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: name,
    ownership: "app"
  });
  s.agentStore.getOrCreateThread("worker", workerId);
  // Unfinished: a step still in progress, and nothing that will wake the worker.
  s.plans.update(workerId, { conclusion: "half done", steps: [{ title: "the next part", status: "in_progress" }] });
  return workerId;
}

/** Render the wake context as it would look on a wake with this reason. */
function render(s: ReturnType<typeof setup>, reason: AgentWakeReason): string {
  s.agentStore.createWake({ threadId: s.manager.id, reason, triggerMessageId: null });
  return buildWorkItemWakeSection(s.manager.id, s.workItems, s.agentStore, s.plans);
}

describe("the sweep section is gated on the wake that asked for it", () => {

  test("is absent on a user wake, even with the same stalled worker", () => {
    // Every other wake arrives with its own errand. Handing it the standing
    // list as well is how a list stops being read.
    const s = setup();
    stalledWorker(s, "stuck");
    expect(render(s, "user")).not.toContain(SWEEP_HEADER);
  });

  test("retains the interrupted sweep context when a new user message also triggers recovery", () => {
    const s = setup();
    try {
      const workerId = stalledWorker(s, "recovering");
      render(s, "sweep");
      s.agentStore.recoverInterruptedWakes("restart");
      s.agentStore.createWake({ threadId: s.manager.id, reason: "user", triggerMessageId: "latest-input" });
      const text = buildWorkItemWakeSection(s.manager.id, s.workItems, s.agentStore, s.plans);
      expect(text).toContain(SWEEP_HEADER);
      expect(text).toContain(workerId);
    } finally { s.db.close(); }
  });

  test("is absent on a worker-report wake", () => {
    const s = setup();
    stalledWorker(s, "stuck");
    expect(render(s, "worker-report")).not.toContain(SWEEP_HEADER);
  });

  test("is absent when no wake is running", () => {
    const s = setup();
    stalledWorker(s, "stuck");
    const text = buildWorkItemWakeSection(s.manager.id, s.workItems, s.agentStore, s.plans);
    expect(text).not.toContain(SWEEP_HEADER);
  });
});

describe("what the sweep section says", () => {
  test("names the section and tells the agent it may end the sweep", () => {
    const s = setup();
    stalledWorker(s, "stuck");
    const text = render(s, "sweep");

    expect(text).toContain(SWEEP_HEADER);
    expect(text).toContain("end_sweep");
    expect(text).toContain("no running wake · no pending alarm · no undelivered event · no pane monitor · no command monitor");
    // The line is the plan's, so the manager sees which step stopped.
    expect(text).toContain("In progress · 0/1] half done — now #1: the next part");
    expect(text).not.toContain("mark it done");
  });

  test("still renders with nothing stalled, and says so", () => {
    // The empty sweep is the one that ends the loop: the agent has to be told
    // it looked and found nothing, or it has no reason to call end_sweep.
    const s = setup();
    const text = render(s, "sweep");

    // Under the sweep's own header: other sections say "(none)" too.
    expect(text).toContain(`${SWEEP_HEADER}\n(none)\n`);
    expect(text).toContain("end_sweep");
  });

  test("a stalled worker does not also appear as passive FYI", () => {
    // It is fresh enough for listIdle's 24h window, so without care it would be
    // listed twice — once as needing action, once under "no action needed".
    const s = setup();
    const workerId = stalledWorker(s, "stuck");
    const text = render(s, "sweep");

    const fyi = text.slice(
      text.indexOf("--- RECENT PASSIVE UPDATES"),
      text.indexOf(SWEEP_HEADER)
    );
    expect(fyi).not.toContain(workerId);
  });

  test("the sections render in order", () => {
    const s = setup();
    const text = render(s, "sweep");
    const order = [
      "--- OPEN WORK ITEMS NEEDING ATTENTION ---",
      "--- RECENT PASSIVE UPDATES (FYI, no action needed) ---",
      SWEEP_HEADER
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

// The index line says what a worker's own page says: Failed after a wake that
// failed, In progress while a wake of it runs on its question's answer.
test("a manager's worker index reads a worker's failure and whether it runs", async () => {
  const { buildManagerScope } = await import("../src/server/runtime/scopes/manager-scope.js");
  const e = freshStoresEnv("md-wctx-index-facts-");
  const projectId = seedProject(e.projects, { name: "project-1" });
  const workStore = new WorkItemStore(e.store.db);
  const planStore = new PlanStore(e.store.db);
  const a = e.agentStore.createManagerThread("A");
  const failed = seedWorker(e.workers, projectId, { name: "broke", tmuxWindowName: "broke" });
  e.workers.setOwner(failed, a.id);
  planStore.update(failed, { conclusion: "half way", steps: [{ title: "Wire", status: "in_progress" }] });
  workStore.setFailure(failed, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
  const answering = seedWorker(e.workers, projectId, { name: "answering", tmuxWindowName: "answering" });
  e.workers.setOwner(answering, a.id);
  planStore.update(answering, { conclusion: "asked", openQuestions: ["Ship it?"], steps: [{ title: "Ship", status: "done", note: "ok" }] });
  const answeringThread = e.agentStore.getOrCreateThread("worker", answering);
  const scope = buildManagerScope({
    agentStore: e.agentStore, projectsStore: e.projects, workersStore: e.workers, records: new WorkerRecordStore(e.store.db),
    workStore, planStore, skillRegistry: stub<SkillRegistry>(), isBusy: (id) => id === answeringThread.id
  });
  const text = (await scope.buildRuntimeContext!(a.id))!;
  expect(text).toMatch(/broke \(id [^)]+\).*; plan: Failed · 0\/1 · half way/);
  expect(text).toMatch(/answering \(id [^)]+\).*; plan: In progress · 1\/1 · asked/);
  // Its line under attention says the same, not that it waits for an answer.
  const attention = text.substring(text.indexOf("OPEN WORK ITEMS NEEDING ATTENTION"), text.indexOf("RECENT PASSIVE UPDATES"));
  expect(attention).toContain("[answering · In progress · 1/1] asked");
  expect(attention).not.toContain("Waiting for an answer");
  e.cleanup();
});

// An archived worker is out of the manager's hands: its last failure is not
// something to act on, and must not crowd out what is.
test("an archived worker whose last wake failed is not under attention", () => {
  const { workers, workItems, agentStore, manager, projectId } = setup();
  const insert = (name: string) => workers.insert({
    projectId, name, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null, tmuxWindowName: name, ownership: "app"
  });
  const live = insert("live");
  const gone = insert("gone");
  for (const f of [live, gone]) workItems.setFailure(f, { at: "2026-09-27T12:00:00.000Z", message: "boom", kind: "error" });
  workers.archive(gone);
  const text = buildWorkItemWakeSection(manager.id, workItems, agentStore);
  const attention = text.substring(text.indexOf("OPEN WORK ITEMS NEEDING ATTENTION"), text.indexOf("RECENT PASSIVE UPDATES"));
  expect(attention).toContain(`/${live} · failed]`);
  expect(attention).not.toContain(gone);
});
