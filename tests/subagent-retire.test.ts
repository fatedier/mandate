import { afterEach, expect, test } from "bun:test";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { SUBAGENT_LIMITS } from "../src/shared/api/background-tasks.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { createMockLLM, createScriptedStreamLLM } from "./helpers/mock-llm.js";
import { waitUntil } from "./helpers/wait.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// A subagent works for one conversation. Whatever ends that conversation —
// a thread's archive, a feature's, a project's, a restart of Mandate — ends
// its subagents too, and only a parent still there hears of them.

type Env = ReturnType<typeof freshStoresEnv>;
type Runtime = ReturnType<typeof buildAgentRuntime>;
const envs: Env[] = [];
const runtimes: Runtime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const env of envs.splice(0)) env.cleanup();
});

function fresh(prefix: string): Env {
  const env = freshStoresEnv(prefix);
  envs.push(env);
  return env;
}

/** The runtime the app builds. Its `ready` never comes unless one is given:
 *  wakes are recorded and then wait, so what the runtime decided is all there is. */
function runtimeOf(env: Env, ready: Promise<void> = new Promise(() => {})): Runtime {
  const runtime = testAgentRuntime(env, {
    ready
  });
  runtimes.push(runtime);
  return runtime;
}

/** What a process that stops leaves behind: its rows, nothing it held in memory. */
function stopProcess(runtime: Runtime): void {
  runtimes.splice(runtimes.indexOf(runtime), 1);
  runtime.dispose();
}

/** The runtime with its turns on test models: a subagent's model call hangs
 *  until its wake is stopped (or answers `childReplies` in turn); any other
 *  conversation answers `replies` in turn. Nothing runs until `letGo`;
 *  `released(threadId)`, asked for first, resolves once that thread's turn
 *  has ended and let it go. Model and prompt only are replaced: the start-up,
 *  mailbox and end-of-turn hooks are the runtime's own. */
function liveRuntime(env: Env, models: { childReplies?: string[]; replies?: string[] } = {}) {
  let letGo!: () => void;
  const ready = new Promise<void>((resolve) => { letGo = resolve; });
  const runtime = runtimeOf(env, ready);
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  const children = models.childReplies
    ? createMockLLM(models.childReplies.map((text) => ({ text, finishReason: "stop" as const })))
    : createScriptedStreamLLM(Array.from({ length: 2 * SUBAGENT_LIMITS.perThread }, () => [{ type: "hang" as const }]));
  const others = createMockLLM((models.replies ?? []).map((text) => ({ text, finishReason: "stop" as const })));
  deps.llmForThread = (threadId) => ({ model: env.agentStore.getThreadById(threadId)?.scope === "subagent" ? children : others });
  deps.llmCallRecorder = undefined;
  deps.buildSystemPrompt = () => "test";
  deps.buildRuntimeContext = () => null;
  deps.buildInitialContext = () => null;
  deps.beforeModelCallHook = undefined;
  const waiting = new Map<string, () => void>();
  const afterRelease = deps.afterWakeReleasedHook;
  deps.afterWakeReleasedHook = async (threadId) => {
    await afterRelease?.(threadId);
    waiting.get(threadId)?.();
  };
  const released = (threadId: string) => new Promise<void>((resolve) => { waiting.set(threadId, resolve); });
  return { runtime, children, letGo, released };
}

const tasksOf = (env: Env) => new BackgroundTaskStore(env.store.db);
const wakesOf = (env: Env, threadId: string) =>
  env.store.db.prepare("select status, reason from agent_wakes where thread_id = ? order by rowid").all(threadId) as Array<{ status: string; reason: string }>;
const resultMailOf = (env: Env, threadId: string) =>
  env.store.db.prepare("select source_thread_id as sourceThreadId, content from agent_mailbox where thread_id = ? and source = 'subagent-result' order by rowid")
    .all(threadId) as Array<{ sourceThreadId: string | null; content: string }>;
const job = (n: number) => ({ title: `project-1 job ${n}`, task: `Do job ${n} from the findings below.` });

/** A worker of an active project, with its conversation. */
function workerOf(env: Env) {
  const projectId = seedProject(env.projects, { name: "project-1" });
  const featureId = seedFeature(env.features, projectId, { name: "Release notes", tmuxWindowName: "release-notes" });
  return { projectId, featureId, thread: env.agentStore.getOrCreateThread("worker", featureId) };
}

test("archiving a thread stops its queued and running subagents, and no result reaches it", async () => {
  const env = fresh("md-subagent-archive-thread-");
  const { runtime, children, letGo } = liveRuntime(env);
  const thread = env.agentStore.createManagerThread("project-1 release");
  const started = Array.from({ length: SUBAGENT_LIMITS.perThread + 1 }, (_, i) => runtime.subagents.start({ parentThreadId: thread.id, ...job(i + 1) }));
  expect(started.map((s) => s.status)).toEqual([...Array<"started">(SUBAGENT_LIMITS.perThread).fill("started"), "queued"]);
  letGo();
  // The running ones are at their model calls when the archive comes.
  await waitUntil(() => children.callsMade === SUBAGENT_LIMITS.perThread, { label: () => `${children.callsMade} model calls` });

  // What ThreadArchive does once the thread's turn and workers are gone. The
  // thread is left open here, so a result that went out would land in it.
  runtime.releaseThreadResources(thread.id);

  const running = started.slice(0, SUBAGENT_LIMITS.perThread);
  // A turn's end step runs before its thread is let go (WakeScheduler.releaseWake).
  await waitUntil(() => running.every((s) => !runtime.wakeScheduler.isThreadBusy(s.task.childThreadId!)));
  expect(started.map((s) => { const task = tasksOf(env).get(s.task.id)!; return [task.status, task.stoppedBy]; }))
    .toEqual(Array.from({ length: SUBAGENT_LIMITS.perThread + 1 }, () => ["stopped", "archive"]));
  expect(running.map((s) => wakesOf(env, s.task.childThreadId!).map((w) => w.status)))
    .toEqual(Array.from({ length: SUBAGENT_LIMITS.perThread }, () => ["canceled"]));
  // The queued one never started.
  expect(wakesOf(env, started.at(-1)!.task.childThreadId!)).toEqual([]);
  expect(resultMailOf(env, thread.id)).toEqual([]);
  expect(wakesOf(env, thread.id)).toEqual([]);
});

test("archiving a feature stops its worker's subagents, and no result reaches the worker", async () => {
  const env = fresh("md-subagent-archive-feature-");
  const { runtime, children, letGo } = liveRuntime(env);
  const worker = workerOf(env);
  const { task } = runtime.subagents.start({ parentThreadId: worker.thread.id, ...job(1) });
  letGo();
  await waitUntil(() => children.callsMade === 1);
  // What every feature archive path calls first. The feature is left active
  // here, so a result that went out would wake the worker.
  runtime.beforeFeatureArchive(worker.featureId);
  await waitUntil(() => !runtime.wakeScheduler.isThreadBusy(task.childThreadId!));
  const after = tasksOf(env).get(task.id)!;
  expect([after.status, after.stoppedBy]).toEqual(["stopped", "archive"]);
  expect(wakesOf(env, task.childThreadId!).map((w) => w.status)).toEqual(["canceled"]);
  expect(resultMailOf(env, worker.thread.id)).toEqual([]);
  expect(wakesOf(env, worker.thread.id)).toEqual([]);
});

test("a project archive stops nothing on its way: its worker's queued subagent never starts, and the first wake refused stops the rest", async () => {
  const env = fresh("md-subagent-archive-project-");
  const { runtime, letGo } = liveRuntime(env, { childReplies: Array.from({ length: 2 * SUBAGENT_LIMITS.perThread }, () => "Found what the task asked for.") });
  const worker = workerOf(env);
  const started = Array.from({ length: SUBAGENT_LIMITS.perThread + 1 }, (_, i) => runtime.subagents.start({ parentThreadId: worker.thread.id, ...job(i + 1) }));
  env.features.archiveByProjectId(worker.projectId);
  letGo();
  await waitUntil(() => tasksOf(env).listOpen().length === 0, { label: () => JSON.stringify(tasksOf(env).listOpen().map((t) => [t.title, t.status])) });
  await waitUntil(() => started.every((s) => !runtime.wakeScheduler.isThreadBusy(s.task.childThreadId!)));
  const queued = tasksOf(env).get(started.at(-1)!.task.id)!;
  expect([queued.status, queued.stoppedBy]).toEqual(["stopped", "archive"]);
  expect(wakesOf(env, queued.childThreadId!)).toEqual([]);
  // Nothing woke the retired worker.
  expect(wakesOf(env, worker.thread.id)).toEqual([]);
});

test("a subagent a worker asks for after its feature was archived never runs, and ends stopped by the archive", () => {
  const env = fresh("md-subagent-retired-start-");
  const runtime = runtimeOf(env);
  const worker = workerOf(env);
  // The worker's turn outlives its feature's archive, and its next call asks for one.
  env.features.archive(worker.featureId);
  const { task } = runtime.subagents.start({ parentThreadId: worker.thread.id, ...job(1) });
  const after = tasksOf(env).get(task.id)!;
  expect([after.status, after.stoppedBy]).toEqual(["stopped", "archive"]);
  expect(wakesOf(env, task.childThreadId!)).toEqual([]);
});

test("a conversation with a subagent queued or running is still at work, as a delete reads it, until its subagent's turn has stopped", async () => {
  const env = fresh("md-subagent-working-");
  let letGo!: () => void;
  const runtime = runtimeOf(env, new Promise<void>((resolve) => { letGo = resolve; }));
  const thread = env.agentStore.createManagerThread("project-1 release");
  expect(runtime.isThreadWorking(thread.id)).toBe(false);
  const { task } = runtime.subagents.start({ parentThreadId: thread.id, ...job(1) });
  expect(runtime.isThreadWorking(thread.id)).toBe(true);
  runtime.subagents.stop(task.id, "agent", thread.id);
  // Asked to stop, its turn has not stopped yet: it could still write into the thread.
  expect(runtime.isThreadWorking(thread.id)).toBe(true);
  // Let go, the cancelled wake ends at once, and its end step records the stop.
  letGo();
  await waitUntil(() => !runtime.isThreadWorking(thread.id), { label: "the subagent's turn to stop" });
  expect(tasksOf(env).get(task.id)).toMatchObject({ status: "stopped", stoppedBy: "agent" });
});

test("a subagent cut short by a restart ends interrupted and its parent is told; its run is not resumed, nor started again by its mail", () => {
  const env = fresh("md-subagent-restart-");
  const thread = env.agentStore.createManagerThread("project-1 release");
  const before = runtimeOf(env);
  const { task } = before.subagents.start({ parentThreadId: thread.id, ...job(1) });
  const cut = env.agentStore.getRunningWakeForThread(task.childThreadId!)!;
  // Its brief, as if it were still in the mail: the queue starts a subagent, never its mail.
  env.agentStore.enqueueMailboxMessage({ threadId: task.childThreadId!, role: "user", source: "subagent-task", content: { type: "text", text: "Do job 1." } });
  stopProcess(before);

  runtimeOf(env);
  expect(tasksOf(env).get(task.id)!.status).toBe("interrupted");
  expect(env.agentStore.getWakeById(cut.id)!.status).toBe("error");
  expect(wakesOf(env, task.childThreadId!)).toHaveLength(1);
  expect(env.agentStore.queuedMailboxSources(task.childThreadId!)).not.toContain("restart-recovery");
  // Its parent is told, by the subagent, and woken for it.
  const mail = resultMailOf(env, thread.id);
  expect(mail.map((m) => m.sourceThreadId)).toEqual([task.childThreadId!]);
  expect(JSON.parse(mail[0]!.content).metadata).toMatchObject({ taskId: task.id, outcome: "interrupted" });
  expect(wakesOf(env, thread.id).map((w) => w.reason)).toEqual(["subagent-result"]);
});

test("after a restart the queued subagents start in the slots the interrupted ones left, and the results reach the parent together", () => {
  const env = fresh("md-subagent-restart-queue-");
  const thread = env.agentStore.createManagerThread("project-1 release");
  const before = runtimeOf(env);
  const started = Array.from({ length: SUBAGENT_LIMITS.perThread + 1 }, (_, i) => before.subagents.start({ parentThreadId: thread.id, ...job(i + 1) }));
  const queued = started.at(-1)!;
  expect(queued.status).toBe("queued");
  stopProcess(before);

  runtimeOf(env);
  expect(started.slice(0, -1).map((s) => tasksOf(env).get(s.task.id)!.status)).toEqual(Array<"interrupted">(SUBAGENT_LIMITS.perThread).fill("interrupted"));
  expect(tasksOf(env).get(queued.task.id)!.status).toBe("running");
  expect(wakesOf(env, queued.task.childThreadId!)).toEqual([{ status: "running", reason: "subagent-task" }]);
  expect(resultMailOf(env, thread.id)).toHaveLength(SUBAGENT_LIMITS.perThread);
  expect(wakesOf(env, thread.id).map((w) => w.reason)).toEqual(["subagent-result"]);
});

test("a parent mid-turn at the restart resumes as its recovery, and reads its subagent's result in that same turn", async () => {
  const env = fresh("md-subagent-restart-parent-");
  const thread = env.agentStore.createManagerThread("project-1 release");
  const asked = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Write up the 0.72 release." } });
  const before = runtimeOf(env);
  const { task } = before.subagents.start({ parentThreadId: thread.id, ...job(1) });
  // The parent's own turn was running too.
  const cut = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: asked.id });
  stopProcess(before);

  const { children, letGo, released } = liveRuntime(env, { replies: ["The job was cut short by the restart; I will start it again."] });
  const done = released(thread.id);
  letGo();
  await done;
  const resumed = env.agentStore.getLatestWakeForThread(thread.id)!;
  expect(resumed.id).not.toBe(cut.id);
  // As its recovery: its own reason and the user's message, not the result's.
  expect([resumed.reason, resumed.triggerMessageId, resumed.status]).toEqual(["user", asked.id, "finished"]);
  expect(env.agentStore.listMailboxMessagesDeliveredToWake(resumed.id).map((m) => m.source).sort()).toEqual(["restart-recovery", "subagent-result"]);
  expect(wakesOf(env, thread.id)).toHaveLength(2);
  expect(tasksOf(env).get(task.id)!.status).toBe("interrupted");
  expect(children.callsMade).toBe(0);
});

test("a retired worker's subagent cut short by a restart ends interrupted, and nothing wakes the worker", () => {
  const env = fresh("md-subagent-restart-retired-");
  const worker = workerOf(env);
  const before = runtimeOf(env);
  const { task } = before.subagents.start({ parentThreadId: worker.thread.id, ...job(1) });
  env.features.archiveByProjectId(worker.projectId);
  stopProcess(before);

  runtimeOf(env);
  expect(tasksOf(env).get(task.id)!.status).toBe("interrupted");
  expect(wakesOf(env, worker.thread.id)).toEqual([]);
});

test("a retired worker with mail waiting at start-up is refused while the runtime is built, and its subagents stop with it", () => {
  const env = fresh("md-subagent-restart-retired-mail-");
  const worker = workerOf(env);
  const before = runtimeOf(env);
  const { task } = before.subagents.start({ parentThreadId: worker.thread.id, ...job(1) });
  // Mail that came while it was busy; then its project was archived.
  env.agentStore.enqueueMailboxMessage({ threadId: worker.thread.id, role: "user", source: "manager", content: { type: "text", text: "Add the migration notes too." } });
  env.features.archiveByProjectId(worker.projectId);
  stopProcess(before);

  // The worker's start-up wake is refused, and the refusal stops its
  // subagents before the runtime has finished being built.
  expect(() => runtimeOf(env)).not.toThrow();
  const after = tasksOf(env).get(task.id)!;
  expect([after.status, after.stoppedBy]).toEqual(["stopped", "archive"]);
  expect(wakesOf(env, worker.thread.id)).toEqual([]);
});

// An outside writer ended its wake's row while its model call still runs:
// the scheduler still holds it, and its end step is still to come.
test("a reconcile leaves alone a subagent whose wake the scheduler still runs, though its row was ended under it", async () => {
  const env = fresh("md-subagent-reconcile-held-");
  const { runtime, children, letGo } = liveRuntime(env);
  const thread = env.agentStore.createManagerThread("project-1 release");
  const { task } = runtime.subagents.start({ parentThreadId: thread.id, ...job(1) });
  letGo();
  await waitUntil(() => children.callsMade === 1, { label: () => `${children.callsMade} model calls` });
  env.agentStore.finishWake(env.agentStore.getRunningWakeForThread(task.childThreadId!)!.id, "finished", null);
  runtime.subagents.reconcile();
  expect(tasksOf(env).get(task.id)!.status).toBe("running");
  expect(resultMailOf(env, thread.id)).toEqual([]);
});
