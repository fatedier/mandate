import { expect, test } from "bun:test";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { threadStatusSnapshot, type ThreadStatusDeps } from "../src/server/modules/personal/thread-status.js";
import { listWaitingOnUser } from "../src/server/modules/personal/waiting-on-user.js";
import type { WaitKind } from "../src/shared/thread-dot.js";
import { createManagerStopCheck } from "../src/server/modules/manager-checks/stop/manager-stop-check.js";
import { createManagerStopCheckStore } from "../src/server/modules/manager-checks/stop/store.js";

function setup(prefix: string) {
  const e = freshStoresEnv(prefix);
  const projectId = seedProject(e.projects, { name: "project-1" });
  const workStore = new WorkItemStore(e.store.db);
  const planStore = new PlanStore(e.store.db);
  const busy = new Set<string>();
  const watching = new Map<string, WaitKind>();
  const agentQuestions: string[] = [];
  const deps: ThreadStatusDeps = {
    agentStore: e.agentStore,
    workersStore: e.workers,
    projectsStore: e.projects,
    workStore,
    planStore,
    managerThreads: new ManagerThreadService({ agentStore: e.agentStore }),
    isBusy: (id) => busy.has(id),
    waitKind: (id) => watching.get(id) ?? null,
    agentQuestions: () => agentQuestions,
    // The manager stop check's verdicts, as the runtime keeps them; nothing judges here.
    verdictOf: (threadId: string) => managerStopCheck.current(threadId)
  };
  const verdicts = createManagerStopCheckStore(e.store.db);
  const managerStopCheck = createManagerStopCheck({ agentStore: e.agentStore, workersStore: e.workers, store: verdicts, stopOf: () => null, candidates: () => [] });
  /** A manager thread whose latest reply the manager stop check found leaves the user `outcome`. */
  const judged = (title: string, outcome: "decision" | "result", text: string) => {
    const thread = e.agentStore.createManagerThread(title);
    e.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Plan the release" } });
    const reply = e.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text } });
    verdicts.set(thread.id, { replySeq: reply.seq, outcome, judgedAt: "2026-10-22T10:00:00.000Z" });
    return { thread, reply };
  };
  const worker = (name: string, ownerThreadId: string) => {
    const workerId = seedWorker(e.workers, projectId, { name, tmuxWindowName: name });
    e.workers.setOwner(workerId, ownerThreadId);
    return { workerId, thread: e.agentStore.getOrCreateThread("worker", workerId) };
  };
  const failTurn = (threadId: string, status: "error" | "stuck", message: string) => {
    const wake = e.agentStore.createWake({ threadId, reason: "user", triggerMessageId: null });
    e.agentStore.finishWake(wake.id, status, message);
  };
  const ask = (threadId: string, question: string) => e.agentStore.appendMessage({
    threadId, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: `c_${question.length}`, toolName: "ask_user", result: { asked: true, questionId: `q_${question.length}`, question, options: [] } }
  });
  return { ...e, deps, busy, watching, agentQuestions, workStore, planStore, worker, failTurn, ask, judged };
}

test("a finished worker under a working manager: working, and nothing waits", () => {
  const s = setup("md-snap-working-");
  const manager = s.agentStore.createManagerThread("Release notes");
  const w = s.worker("changelog", manager.id);
  s.planStore.update(w.workerId, { conclusion: "Written.", steps: [{ title: "Write", status: "done", note: "ok" }] });
  s.busy.add(manager.id);
  const snap = threadStatusSnapshot(s.deps);
  expect(snap.threads).toEqual([{ threadId: manager.id, state: "working" }]);
  expect(snap.waiting).toEqual([]);
});

test("a failed manager turn is red and listed as failed, with its error", () => {
  const s = setup("md-snap-failed-");
  const manager = s.agentStore.createManagerThread("Release notes");
  s.failTurn(manager.id, "error", "The provider refused the request.");
  const snap = threadStatusSnapshot(s.deps);
  expect(snap.threads[0]!.state).toBe("failed");
  expect(snap.waiting).toEqual([{
    key: `thread:${manager.id}:failed`, kind: "thread", waiting: "failed", threadId: manager.id, threadTitle: "Release notes",
    workerId: null, workerName: null, text: "The provider refused the request.", place: null
  }]);
});

test("a turn stopped by the repeat check is listed as stopped, with its reason", () => {
  const s = setup("md-snap-stuck-");
  const manager = s.agentStore.createManagerThread("Release notes");
  s.failTurn(manager.id, "stuck", "read failed 5 times in a row: ENOENT");
  const snap = threadStatusSnapshot(s.deps);
  expect(snap.waiting.map((entry) => [entry.waiting, entry.text])).toEqual([["stopped", "read failed 5 times in a row: ENOENT"]]);
});

test("a failed worker under an idle manager: idle, and no row for it", () => {
  const s = setup("md-snap-worker-failed-");
  const manager = s.agentStore.createManagerThread("Release notes");
  const w = s.worker("changelog", manager.id);
  s.workStore.setFailure(w.workerId, { at: "2026-09-27T12:00:00.000Z", message: "provider 500", kind: "error" });
  const snap = threadStatusSnapshot(s.deps);
  expect(snap.threads[0]!.state).toBe("idle");
  expect(snap.waiting).toEqual([]);
});

test("a resting thread's worker question is a row of its own; a working thread's is not yet", () => {
  const s = setup("md-snap-worker-asks-");
  const manager = s.agentStore.createManagerThread("Release notes");
  const w = s.worker("changelog", manager.id);
  s.planStore.update(w.workerId, { openQuestions: ["Mention the breaking change?"], steps: [{ title: "Write", status: "in_progress" }] });
  expect(threadStatusSnapshot(s.deps).waiting).toEqual([{
    key: `worker:${w.workerId}:input`, kind: "worker", waiting: "input", threadId: manager.id, threadTitle: "Release notes",
    workerId: w.workerId, workerName: "changelog", text: "Mention the breaking change?",
    place: { projectName: "project-1", projectSlug: "md-p", workerSlug: "changelog" }
  }]);
  expect(threadStatusSnapshot(s.deps).threads[0]!.state).toBe("needs_you");
  s.busy.add(manager.id);
  expect(threadStatusSnapshot(s.deps).waiting).toEqual([]);
});

// A row opens where it is about with what the snapshot says alone: the
// client's projects list can arrive later, or no longer hold an archived one.
test("a worker's row says where the worker lives; a worker with no thread is listed under its project", () => {
  const s = setup("md-snap-worker-place-");
  const workerId = seedWorker(s.workers, s.projects.listActive()[0]!.id, { name: "loose", tmuxWindowName: "loose-win" });
  s.planStore.update(workerId, { openQuestions: ["Which branch?"], steps: [{ title: "Pick", status: "in_progress" }] });
  expect(threadStatusSnapshot(s.deps).waiting).toEqual([{
    key: `worker:${workerId}:input`, kind: "worker", waiting: "input", threadId: null, threadTitle: null,
    workerId, workerName: "loose", text: "Which branch?",
    place: { projectName: "project-1", projectSlug: "md-p", workerSlug: "loose-win" }
  }]);
});

test("one order: what broke, then questions (the personal agent's, a manager's, a worker's), each kind in turn", () => {
  const s = setup("md-snap-order-");
  const asking = s.agentStore.createManagerThread("Tag the release");
  s.ask(asking.id, "Tag 3.21 today?");
  const broken = s.agentStore.createManagerThread("Cache work");
  s.failTurn(broken.id, "error", "boom");
  const resting = s.agentStore.createManagerThread("Docs overhaul");
  const w = s.worker("docs", resting.id);
  s.planStore.update(w.workerId, { openQuestions: ["Keep the old page?"], steps: [{ title: "Rewrite", status: "in_progress" }] });
  s.agentQuestions.push("Which of these first?");
  const snap = threadStatusSnapshot(s.deps);
  expect(snap.waiting.map((entry) => [entry.kind, entry.waiting, entry.threadTitle])).toEqual([
    ["thread", "failed", "Cache work"],
    ["agent", "input", null],
    ["question", "input", "Tag the release"],
    ["worker", "input", "Docs overhaul"]
  ]);
});

test("the personal agent's list leaves out its own question, and lists a thread that failed", () => {
  const s = setup("md-snap-agent-");
  const broken = s.agentStore.createManagerThread("Cache work");
  s.failTurn(broken.id, "error", "boom");
  s.agentQuestions.push("Which of these first?");
  const items = listWaitingOnUser(s.deps, s.deps.managerThreads.list());
  expect(items).toEqual([{ kind: "thread", threadId: broken.id, threadTitle: "Cache work", label: "Failed", waiting: "failed", reason: "boom" }]);
});

// The thread's last turn failed until another one starts: busy behind it
// (a message queued, a retry due) is not yet a turn, and may never be one.
test("a failed thread stays failed and listed until its next turn starts; then it is working", () => {
  const s = setup("md-snap-failed-next-");
  const manager = s.agentStore.createManagerThread("Release notes");
  s.failTurn(manager.id, "error", "The provider refused the request.");
  s.busy.add(manager.id);
  expect(threadStatusSnapshot(s.deps).threads[0]!.state).toBe("failed");
  expect(threadStatusSnapshot(s.deps).waiting.map((entry) => entry.waiting)).toEqual(["failed"]);
  s.agentStore.createWake({ threadId: manager.id, reason: "user", triggerMessageId: null });
  const snap = threadStatusSnapshot(s.deps);
  expect(snap.threads[0]!.state).toBe("working");
  expect(snap.waiting).toEqual([]);
});

test("the workers' plans are read once per snapshot, all together", () => {
  const s = setup("md-snap-plan-reads-");
  const manager = s.agentStore.createManagerThread("Release notes");
  s.worker("changelog", manager.id);
  s.worker("docs", manager.id);
  let together = 0;
  let one = 0;
  const deps = {
    ...s.deps,
    planStore: {
      statesOfActive: () => { together++; return s.planStore.statesOfActive(); },
      stateOf: (workerId: string) => { one++; return s.planStore.stateOf(workerId); }
    }
  };
  threadStatusSnapshot(deps);
  expect([together, one]).toEqual([1, 0]);
});

// A verdict shows while the thread has stopped on its reply and nobody read it.
test("a stopped thread with a current decision is blue and on Home, with its reply", () => {
  const s = setup("md-snap-verdict-");
  const { thread } = s.judged("Release plan", "decision", "Two options: ship Friday or wait for the fix?");
  const snap = threadStatusSnapshot(s.deps);
  expect(snap.threads[0]).toEqual({ threadId: thread.id, state: "decision" });
  expect(snap.waiting).toEqual([{
    key: `thread:${thread.id}:decision`, kind: "thread", waiting: "decision", threadId: thread.id, threadTitle: "Release plan",
    workerId: null, workerName: null, text: "Two options: ship Friday or wait for the fix?", place: null
  }]);
  // The personal agent's list reads the same.
  expect(listWaitingOnUser(s.deps, s.deps.managerThreads.list())).toEqual([
    { kind: "thread", threadId: thread.id, threadTitle: "Release plan", label: "Decision needed", waiting: "decision", reason: "Two options: ship Friday or wait for the fix?" }
  ]);
});

test("a thread with a verdict that works again, or waits, or asks, is that, and its verdict is not listed", () => {
  const s = setup("md-snap-verdict-working-");
  const { thread } = s.judged("Release plan", "result", "The changelog is written.");
  s.busy.add(thread.id);
  expect([threadStatusSnapshot(s.deps).threads[0]!.state, threadStatusSnapshot(s.deps).waiting]).toEqual(["working", []]);
  s.busy.clear();
  s.watching.set(thread.id, "pane");
  expect([threadStatusSnapshot(s.deps).threads[0]!.state, threadStatusSnapshot(s.deps).waiting]).toEqual(["watching", []]);
  s.watching.clear();
  const w = s.worker("notes", thread.id);
  s.busy.add(w.thread.id);
  expect([threadStatusSnapshot(s.deps).threads[0]!.state, threadStatusSnapshot(s.deps).waiting]).toEqual(["working", []]);
  s.busy.clear();
  s.ask(thread.id, "Tag it too?");
  expect(threadStatusSnapshot(s.deps).threads[0]!.state).toBe("needs_you");
  expect(threadStatusSnapshot(s.deps).waiting.map((entry) => entry.waiting)).toEqual(["input"]);
});

test("reading the reply clears it", () => {
  const s = setup("md-snap-verdict-read-");
  const { thread, reply } = s.judged("Release plan", "result", "The changelog is written.");
  expect(threadStatusSnapshot(s.deps).threads[0]!.state).toBe("result");
  s.agentStore.markThreadSeen(thread.id, reply.seq);
  expect([threadStatusSnapshot(s.deps).threads[0]!.state, threadStatusSnapshot(s.deps).waiting]).toEqual(["idle", []]);
});

test("The personal agent held back three times in a row waits on the user on Home", () => {
  const s = setup("md-snap-agent-held-");
  const personal = s.agentStore.getOrCreatePersonalThread();
  const snap = threadStatusSnapshot({ ...s.deps, agentHeldBack: () => ({ threadId: personal.id, held: { times: 3, reason: "Deletes the shared build." } }) });
  expect(snap.waiting).toEqual([expect.objectContaining({
    kind: "agent", waiting: "input", threadId: personal.id, text: "Held back 3 times in a row by the tool-call review. Last: Deletes the shared build."
  })]);
  // Its own question and its run of holds are two rows.
  s.agentQuestions.push("Ship Friday?");
  const both = threadStatusSnapshot({ ...s.deps, agentHeldBack: () => ({ threadId: personal.id, held: { times: 3, reason: "Deletes the shared build." } }) });
  expect(new Set(both.waiting.map((entry) => entry.key)).size).toBe(2);
});
