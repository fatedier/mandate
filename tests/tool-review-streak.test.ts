import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/server/config.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import { HandoffStore } from "../src/server/modules/personal/handoff-store.js";
import { threadStatusSnapshot } from "../src/server/modules/personal/thread-status.js";
import type { JudgementCandidate } from "../src/server/modules/manager-checks/judge.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ToolReviewGate } from "../src/server/modules/tool-review/gate.js";
import { HELD_STREAK_MARK, ToolReviewStreaks } from "../src/server/modules/tool-review/streak-store.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { freshStoresEnv, seedWorker, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";

// The review holds a call back; held back again and again, the thread can
// only move on with the user's word, so after three in a row it is marked as
// needing them. A call the review lets through, or the user's own message,
// ends the run.

let env: StoresEnv;
let root: string;
beforeEach(() => {
  env = freshStoresEnv("md-tool-review-streak-");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "md-streak-")));
});
afterEach(() => {
  env.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

const HOLD = '{"hold": true, "reason": "Deletes the shared build."}';
const ALLOW = '{"hold": false, "reason": "The user asked for it."}';
const rm = (id: string) => ({ toolCallId: id, toolName: "bash", args: { command: "rm -rf /srv/build" } });

function setup(answers: string[], extra: Partial<ConstructorParameters<typeof ToolReviewGate>[0]> = {}) {
  const model = createMockLLM(answers.map((text) => ({ text, finishReason: "stop" as const })), { mode: "stream" });
  const recorder = new AgentLlmCallRecorder({ store: env.store, logRequests: "metadata", provider: "gw", model: "m", baseURL: "", apiMode: "streamText" });
  const secondLook = { kind: "chat", model, provider: "openai-compatible", supportsReasoning: false, recorder } as JudgementCandidate;
  const streaks = new ToolReviewStreaks({ db: env.store.db, agentStore: env.agentStore, workers: env.workers });
  const scope: AgentScope = { kind: "manager", managerDir: path.join(root, "notes"), projectWorkingDirs: [] };
  const config: Config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, toolReviewEnabled: true } };
  const gate = new ToolReviewGate({
    config: () => config,
    available: () => true,
    agentStore: env.agentStore,
    workers: env.workers,
    projects: env.projects,
    handoffs: new HandoffStore(env.store.db),
    scopeOf: () => scope,
    models: () => ({ screen: [], secondLook: [secondLook], own: null }),
    paneFacts: async () => null,
    scratch: [],
    streaks,
    ...extra
  });
  const snapshot = () => threadStatusSnapshot({
    agentStore: env.agentStore,
    workersStore: env.workers,
    projectsStore: env.projects,
    workStore: new WorkItemStore(env.store.db),
    planStore: new PlanStore(env.store.db),
    managerThreads: new ManagerThreadService({ agentStore: env.agentStore }),
    isBusy: () => false,
    waitKind: () => null,
    heldBack: (threadId) => streaks.mark(threadId),
    agentQuestions: () => []
  });
  let n = 0;
  const step = (threadId: string) => gate.reviewStep(threadId, "wake-1", [rm(`c${n++}`)]);
  return { gate, streaks, snapshot, step };
}

test("three holds in a row mark the thread as needing you", async () => {
  // The mark gives the last hold's reason.
  const s = setup([HOLD.replace("the shared build", "the old logs"), HOLD.replace("the shared build", "the cache"), HOLD]);
  const thread = env.agentStore.createManagerThread("Release");
  await s.step(thread.id);
  await s.step(thread.id);
  expect(s.streaks.mark(thread.id)).toBeNull();
  expect(s.snapshot().threads).toEqual([{ threadId: thread.id, state: "idle" }]);
  await s.step(thread.id);
  expect(HELD_STREAK_MARK).toBe(3);
  expect(s.streaks.mark(thread.id)).toEqual({ times: 3, reason: "Deletes the shared build." });
  const snap = s.snapshot();
  expect(snap.threads).toEqual([{ threadId: thread.id, state: "needs_you" }]);
  expect(snap.waiting).toEqual([expect.objectContaining({ kind: "thread", waiting: "input", threadId: thread.id, threadTitle: "Release" })]);
  expect(snap.waiting[0]!.text).toContain("Deletes the shared build.");
});

test("a subagent's holds count for the conversation it works for, its allowed call ends that run, and each review tells the status", async () => {
  const parent = env.agentStore.createManagerThread("Release");
  const subagent = env.agentStore.createSubagentThread("task-1");
  let changed = 0;
  const s = setup([HOLD, HOLD, HOLD, ALLOW], {
    parentThreadOf: (threadId) => (threadId === subagent.id ? parent.id : null),
    onStreakChanged: () => { changed += 1; }
  });
  for (let i = 0; i < 3; i += 1) await s.step(subagent.id);
  expect(s.streaks.mark(parent.id)).toStrictEqual({ times: 3, reason: "Deletes the shared build." });
  expect(changed).toBe(3);
  await s.step(subagent.id);
  expect(s.streaks.mark(parent.id)).toBeNull();
  expect(changed).toBe(4);
});

test("an allowed reviewed call clears the mark", async () => {
  const s = setup([HOLD, HOLD, HOLD, ALLOW]);
  const thread = env.agentStore.createManagerThread("Release");
  for (let i = 0; i < 3; i += 1) await s.step(thread.id);
  expect(s.streaks.mark(thread.id)).not.toBeNull();
  await s.step(thread.id);
  expect(s.streaks.mark(thread.id)).toBeNull();
  expect(s.snapshot().waiting).toEqual([]);
});

test("the user's message in the thread clears the mark", async () => {
  const s = setup([HOLD, HOLD, HOLD, HOLD, HOLD]);
  const thread = env.agentStore.createManagerThread("Release");
  for (let i = 0; i < 3; i += 1) await s.step(thread.id);
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Keep the build, clear the cache instead." } });
  expect(s.streaks.mark(thread.id)).toBeNull();
  // A run starts again after their message: two more holds are not three in a row.
  await s.step(thread.id);
  await s.step(thread.id);
  expect(s.streaks.mark(thread.id)).toBeNull();
});

test("a held worker marks its manager's thread", async () => {
  const s = setup([HOLD, HOLD, HOLD]);
  const manager = env.agentStore.createManagerThread("Release");
  const projectId = seedProject(env.projects, { name: "shop", workingDir: path.join(root, "shop") });
  const workerId = seedWorker(env.workers, projectId, { name: "cleanup", tmuxWindowName: "cleanup" });
  env.workers.setOwner(workerId, manager.id);
  const worker = env.agentStore.getOrCreateThread("worker", workerId);
  for (let i = 0; i < 3; i += 1) await s.step(worker.id);
  const snap = s.snapshot();
  expect(snap.threads).toEqual([{ threadId: manager.id, state: "needs_you" }]);
  expect(snap.waiting).toEqual([expect.objectContaining({ kind: "worker", waiting: "input", workerId, workerName: "cleanup", threadId: manager.id })]);
  // The user answering in the manager's thread clears the worker's mark too.
  env.agentStore.appendMessage({ threadId: manager.id, role: "user", source: "user", content: { type: "text", text: "Leave the build alone." } });
  expect(s.snapshot().threads).toEqual([{ threadId: manager.id, state: "idle" }]);
});

test("moving a held worker to another manager does not bring back a mark the user answered, nor does the answered thread going", async () => {
  const s = setup([HOLD, HOLD, HOLD]);
  const first = env.agentStore.createManagerThread("Release");
  const second = env.agentStore.createManagerThread("Cleanup");
  const projectId = seedProject(env.projects, { name: "shop", workingDir: path.join(root, "shop") });
  const workerId = seedWorker(env.workers, projectId, { name: "cleanup", tmuxWindowName: "cleanup" });
  env.workers.setOwner(workerId, first.id);
  const worker = env.agentStore.getOrCreateThread("worker", workerId);
  for (let i = 0; i < 3; i += 1) await s.step(worker.id);
  env.agentStore.appendMessage({ threadId: first.id, role: "user", source: "user", content: { type: "text", text: "Leave the build alone." } });
  env.workers.setOwner(workerId, second.id);
  expect(s.streaks.mark(worker.id)).toBeNull();
  expect(s.snapshot().waiting).toEqual([]);
  // The thread the user answered in goes: the run stays ended.
  env.store.db.prepare(`delete from agent_messages where thread_id = ?`).run(first.id);
  expect(s.streaks.mark(worker.id)).toBeNull();
});

test("a worker moved to another manager keeps its run until the user answers or a call goes through", async () => {
  const s = setup([HOLD, HOLD, HOLD, HOLD]);
  const first = env.agentStore.createManagerThread("Release");
  const second = env.agentStore.createManagerThread("Cleanup");
  env.agentStore.appendMessage({ threadId: first.id, role: "user", source: "user", content: { type: "text", text: "Clean up the old builds." } });
  const projectId = seedProject(env.projects, { name: "shop", workingDir: path.join(root, "shop") });
  const workerId = seedWorker(env.workers, projectId, { name: "cleanup", tmuxWindowName: "cleanup" });
  env.workers.setOwner(workerId, first.id);
  const worker = env.agentStore.getOrCreateThread("worker", workerId);
  for (let i = 0; i < 3; i += 1) await s.step(worker.id);
  env.workers.setOwner(workerId, second.id);
  await s.step(worker.id);
  expect(s.streaks.mark(worker.id)).toEqual({ times: 4, reason: "Deletes the shared build." });
  expect(s.snapshot().threads).toContainEqual({ threadId: second.id, state: "needs_you" });
});

test("what the personal agent relays into the thread does not end the run", async () => {
  const s = setup([HOLD, HOLD, HOLD]);
  const thread = env.agentStore.createManagerThread("Release");
  for (let i = 0; i < 3; i += 1) await s.step(thread.id);
  env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "The user says go ahead.", relay: { by: "personal", spoken: false, handoffId: "hof_1" } }
  });
  expect(s.streaks.mark(thread.id)).toEqual({ times: 3, reason: "Deletes the shared build." });
});

test("the user's message in the manager's thread ends an archived worker's run too", async () => {
  const s = setup([HOLD, HOLD, HOLD]);
  const manager = env.agentStore.createManagerThread("Release");
  const projectId = seedProject(env.projects, { name: "shop", workingDir: path.join(root, "shop") });
  const workerId = seedWorker(env.workers, projectId, { name: "cleanup", tmuxWindowName: "cleanup" });
  env.workers.setOwner(workerId, manager.id);
  const worker = env.agentStore.getOrCreateThread("worker", workerId);
  for (let i = 0; i < 3; i += 1) await s.step(worker.id);
  env.workers.archive(workerId);
  env.agentStore.appendMessage({ threadId: manager.id, role: "user", source: "user", content: { type: "text", text: "Leave the build alone." } });
  expect(s.streaks.mark(worker.id)).toBeNull();
});

test("the user's reply taken in behind a running turn ends the run at once", async () => {
  const s = setup([HOLD, HOLD, HOLD]);
  const thread = env.agentStore.createManagerThread("Release");
  for (let i = 0; i < 3; i += 1) await s.step(thread.id);
  const changed: string[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore: env.agentStore,
    wakeScheduler: { wake: () => null, isThreadBusy: () => true },
    onUserWords: (threadId) => s.streaks.answered(threadId),
    onQueueChanged: (threadId) => changed.push(threadId)
  });
  // What the personal agent relays, waiting the same way, is not the user's word.
  queue.submitThreadUserMessage({ threadId: thread.id, content: "The user says go ahead.", source: "user", relay: { by: "personal", spoken: false, handoffId: "hof_1" } });
  expect(s.streaks.mark(thread.id)).not.toBeNull();
  changed.length = 0;
  const sent = queue.submitThreadUserMessage({ threadId: thread.id, content: "Keep the build.", source: "user" });
  expect(sent.queued).toBe(true);
  expect(s.streaks.mark(thread.id)).toBeNull();
  // Ended before the queue says it changed, so what shows the mark reads it ended.
  expect(changed).toEqual([thread.id]);
});

test("a reply that waited ends the runs before it once, not a run that began while it waited; each end is announced", async () => {
  const s = setup([HOLD, HOLD, HOLD]);
  const announced: string[] = [];
  const streaks = new ToolReviewStreaks({ db: env.store.db, agentStore: env.agentStore, workers: env.workers, onChanged: () => announced.push("changed") });
  const manager = env.agentStore.createManagerThread("Release");
  const projectId = seedProject(env.projects, { name: "shop", workingDir: path.join(root, "shop") });
  const workerId = seedWorker(env.workers, projectId, { name: "cleanup", tmuxWindowName: "cleanup" });
  env.workers.setOwner(workerId, manager.id);
  const worker = env.agentStore.getOrCreateThread("worker", workerId);
  // Taken in behind the manager's running turn: heard now, announced.
  streaks.answered(manager.id);
  expect(announced).toEqual(["changed"]);
  // The worker is held back three times while the reply waits.
  for (let i = 0; i < 3; i += 1) await s.step(worker.id);
  // The reply lands, carrying when it arrived: the worker's new run stands.
  env.agentStore.appendMessage({ threadId: manager.id, role: "user", source: "user", content: { type: "text", text: "Keep the build.", arrivedAt: new Date(Date.now() - 5000).toISOString() } });
  expect(streaks.mark(worker.id)).toEqual({ times: 3, reason: "Deletes the shared build." });
});

test("a reply is taken in even when ending the run fails", () => {
  const thread = env.agentStore.createManagerThread("Release");
  const queue = new AgentUserMessageQueue({
    agentStore: env.agentStore,
    wakeScheduler: { wake: () => null, isThreadBusy: () => true },
    onUserWords: () => { throw new Error("database is locked"); }
  });
  const sent = queue.submitThreadUserMessage({ threadId: thread.id, content: "Keep the build.", source: "user" });
  expect(sent.queued).toBe(true);
  expect(queue.pendingCount(thread.id)).toBe(1);
});
