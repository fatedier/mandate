import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { createSubagentService } from "../src/server/runtime/subagents.js";
import type { PostWakeInfo } from "../src/server/modules/agent/wake-loop.js";
import type { BackgroundTaskDto } from "../src/shared/api-contracts.js";
import { formatSubagentDuration } from "../src/shared/subagent-messages.js";
import { subagentTaskOf } from "../src/shared/subagent-task.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { onCleanup } from "./helpers/cleanup.js";
import { waitUntil } from "./helpers/wait.js";

/** Its retry timers end with the test. */
const onCleanupService = (service: { dispose(): void }) => onCleanup(() => service.dispose());

// The service alone, its scheduler a fake: what a run's end records and who
// is told, for each way a child's wake ends. The real wakes are in
// tests/subagents-runtime.test.ts.

function scene(prefix: string, { childWakes = true, now }: { childWakes?: boolean; now?: () => Date } = {}) {
  const env = freshStoresEnv(prefix);
  const tasks = new BackgroundTaskStore(env.store.db);
  const woken: Array<[string, string]> = [];
  const canceled: string[] = [];
  // The wake the fake scheduler says runs a child, by its thread.
  const running = new Map<string, string>();
  const service = createSubagentService({
    db: env.store.db, tasks, agentStore: env.agentStore, featuresStore: env.features,
    sse: { emit: () => {} },
    wake: (threadId, reason) => {
      woken.push([threadId, reason]);
      return reason === "subagent-task" && !childWakes ? null : `wake_${woken.length}`;
    },
    cancelWake: (wakeId) => { canceled.push(wakeId); return { status: "running" }; },
    runningWakeOf: (threadId) => { const id = running.get(threadId); return id ? { id } : null; },
    ...(now ? { now } : {})
  });
  const start = (parentThreadId: string, title = "Find the retry call sites") =>
    service.start({ parentThreadId, title, task: `Do this: ${title}.` });
  /** The child's one wake as the scheduler leaves it, then its end step. */
  const childWake = (task: BackgroundTaskDto, status: PostWakeInfo["status"], write: (wakeId: string) => void = () => {}, errorMessage: string | null = null) => {
    const wake = env.agentStore.createWake({ threadId: task.childThreadId!, reason: "subagent-task", triggerMessageId: null });
    write(wake.id);
    env.agentStore.finishWake(wake.id, status, errorMessage);
    service.onChildWakeEnded(task.childThreadId!, { wakeId: wake.id, status });
    return wake.id;
  };
  const say = (task: BackgroundTaskDto, wakeId: string, text: string) =>
    env.agentStore.appendMessage({ threadId: task.childThreadId!, role: "assistant", source: "self", wakeId, content: { type: "assistant", text } });
  const mail = (threadId: string) =>
    (env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'subagent-result' order by rowid").all(threadId) as Array<{ content: string }>)
      .map((row) => JSON.parse(row.content) as { text: string; metadata: Record<string, unknown> });
  return { env, tasks, service, woken, canceled, running, start, childWake, say, mail };
}

const durationOf = (task: BackgroundTaskDto) => Date.parse(task.finishedAt!) - Date.parse(task.startedAt ?? task.createdAt);

const ENDINGS: Array<{
  name: string; wake: PostWakeInfo["status"]; errorMessage?: string; cutOff?: boolean;
  status: string; stoppedBy: string | null; error: string | null; says: (after: string) => string;
}> = [
  { name: "finished", wake: "finished", status: "finished", stoppedBy: null, error: null, says: (after) => `finished after ${after}.` },
  { name: "cut off", wake: "finished", cutOff: true, status: "failed", stoppedBy: null, error: "its replies kept reaching the output token limit", says: (after) => `failed after ${after}: its replies kept reaching the output token limit.` },
  { name: "a model error", wake: "error", errorMessage: "The provider refused the request.", status: "failed", stoppedBy: null, error: "The provider refused the request.", says: (after) => `failed after ${after}: The provider refused the request.` },
  { name: "an error with no message", wake: "error", status: "failed", stoppedBy: null, error: "unknown error", says: (after) => `failed after ${after}: unknown error.` },
  { name: "the repeated failing call", wake: "stuck", errorMessage: "read failed 5 times in a row: ENOENT", status: "failed", stoppedBy: null, error: "it kept repeating a failing call", says: (after) => `failed after ${after}: it kept repeating a failing call.` },
  { name: "a Stop on its own turn", wake: "canceled", status: "stopped", stoppedBy: "user", error: null, says: (after) => `stopped by the user after ${after}, before it finished.` }
];

test("a run ends as its child's wake ended, and its conversation reads why and is woken for it", () => {
  const s = scene("md-subagents-endings-");
  try {
    for (const ending of ENDINGS) {
      const parent = s.env.agentStore.createManagerThread(ending.name);
      const { task } = s.start(parent.id);
      s.childWake(task, ending.wake, (wakeId) => {
        s.say(task, wakeId, "Found what I could.");
        if (ending.cutOff) {
          s.env.agentStore.appendMessage({
            threadId: task.childThreadId!, role: "system", source: "wake-failure", wakeId,
            content: { type: "wake_failure", status: "cut_off", message: "Cut off at the output token limit.", stepCount: 3 }
          });
        }
      }, ending.errorMessage ?? null);
      const ended = s.tasks.get(task.id)!;
      expect([ending.name, ended.status, ended.stoppedBy, ended.error, s.tasks.replyOf(task.id)])
        .toEqual([ending.name, ending.status, ending.stoppedBy, ending.error, "Found what I could."]);
      const [result] = s.mail(parent.id);
      expect([ending.name, result?.text])
        .toEqual([ending.name, `[Subagent result] “Find the retry call sites”: ${ending.says(formatSubagentDuration(durationOf(ended)))}\n\nFound what I could.`]);
      expect(result?.metadata).toEqual({
        taskId: task.id, outcome: ending.status, title: "Find the retry call sites", durationMs: durationOf(ended), reply: "Found what I could.",
        // Why it failed, for its card; null when it did not.
        error: ending.error
      });
      expect(s.woken.at(-1)).toEqual([parent.id, "subagent-result"]);
    }
  } finally { s.env.cleanup(); }
});

test("its reply is cut at 20,000 characters: in the run, in what the parent reads and on its card", () => {
  const s = scene("md-subagents-reply-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const { task } = s.start(parent.id);
    s.childWake(task, "finished", (wakeId) => {
      s.say(task, wakeId, "An early note.");
      s.say(task, wakeId, "x".repeat(25_000));
    });
    const reply = s.tasks.replyOf(task.id)!;
    expect([reply.length, reply.endsWith("…")]).toEqual([20_000, true]);
    const [result] = s.mail(parent.id);
    expect(result!.text.endsWith(`\n\n${reply}`)).toBe(true);
    expect(result!.text.length).toBeLessThan(20_200);
    expect(result!.metadata.reply).toBe(reply);
  } finally { s.env.cleanup(); }
});

test("a stop asked for while the wake runs wins however the wake then ends; its own agent's stop tells nobody, the user's tells the conversation", () => {
  const s = scene("md-subagents-pending-stop-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const byAgent = s.start(parent.id, "Wrong brief").task;
    s.running.set(byAgent.childThreadId!, "wake_agent");
    // Still running until its wake has ended: the stop is asked for.
    expect(s.service.stop(byAgent.id, "agent", parent.id)?.status).toBe("running");
    expect(s.canceled).toStrictEqual(["wake_agent"]);
    // Its wake finished before the stop reached it: stopped all the same.
    s.childWake(byAgent, "finished", (wakeId) => { s.say(byAgent, wakeId, "Found it."); });
    expect(s.tasks.get(byAgent.id)).toMatchObject({ status: "stopped", stoppedBy: "agent" });
    expect(s.tasks.replyOf(byAgent.id)).toBe("Found it.");
    expect(s.mail(parent.id)).toEqual([]);
    expect(s.woken.filter(([, reason]) => reason === "subagent-result")).toStrictEqual([]);

    const byUser = s.start(parent.id, "Map the cache layer").task;
    s.running.set(byUser.childThreadId!, "wake_user");
    s.service.stop(byUser.id, "user");
    s.childWake(byUser, "canceled");
    expect(s.tasks.get(byUser.id)).toMatchObject({ status: "stopped", stoppedBy: "user" });
    expect(s.mail(parent.id).map((m) => m.metadata.taskId)).toStrictEqual([byUser.id]);
  } finally { s.env.cleanup(); }
});

test("the first stop of a running run is the one that counts: a second, by the user or its agent, while its wake winds down changes nothing", () => {
  const s = scene("md-subagents-stop-twice-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id, "Wrong brief").task;
    s.running.set(task.childThreadId!, "wake_agent");
    expect(s.service.stop(task.id, "agent", parent.id)?.status).toBe("running");
    // The user's Stop lands before the wake has ended: the agent's stop stands.
    expect(s.service.stop(task.id, "user")?.status).toBe("running");
    expect(s.canceled).toStrictEqual(["wake_agent"]);
    s.childWake(task, "canceled");
    expect(s.tasks.get(task.id)).toMatchObject({ status: "stopped", stoppedBy: "agent" });
    expect(s.mail(parent.id)).toEqual([]);
    expect(s.woken.filter(([, reason]) => reason === "subagent-result")).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

test("another conversation cannot stop it, nor can anyone once it has ended, and it ends once", () => {
  const s = scene("md-subagents-stop-refused-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const other = s.env.agentStore.createManagerThread("Docs");
    const { task } = s.start(parent.id);
    expect(s.service.stop(task.id, "agent", other.id)).toBeNull();
    expect(s.tasks.get(task.id)?.status).toBe("running");
    const wakeId = s.childWake(task, "finished");
    s.service.onChildWakeEnded(task.childThreadId!, { wakeId, status: "finished" });
    expect(s.mail(parent.id)).toHaveLength(1);
    expect(s.service.stop(task.id, "agent", parent.id)).toBeNull();
    expect(s.service.stop("task_missing", "user")).toBeNull();
  } finally { s.env.cleanup(); }
});

test("a queued run stopped by its agent ends at once and tells nobody; one the user stops never starts, and its conversation is told", () => {
  const s = scene("md-subagents-queued-stop-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const runs = Array.from({ length: 8 }, (_, i) => s.start(parent.id, `Job ${i + 1}`));
    expect(runs.map((r) => r.status)).toEqual(["started", "started", "started", "started", "started", "started", "queued", "queued"]);
    const seventh = runs[6]!.task;
    const eighth = runs[7]!.task;
    expect(s.service.stop(seventh.id, "agent", parent.id)).toMatchObject({ status: "stopped", stoppedBy: "agent", startedAt: null });
    expect(s.service.stop(eighth.id, "user")).toMatchObject({ status: "stopped", stoppedBy: "user", startedAt: null });
    expect(s.mail(parent.id).map((m) => m.text)).toEqual([
      `[Subagent result] “Job 8”: stopped by the user after ${formatSubagentDuration(durationOf(s.tasks.get(eighth.id)!))}, before it finished.`
    ]);
    expect(s.woken.filter(([threadId]) => threadId === seventh.childThreadId! || threadId === eighth.childThreadId!)).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

test("a child that cannot be woken fails its run at once, and its conversation hears why", () => {
  const s = scene("md-subagents-no-wake-", { childWakes: false });
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const { task, status } = s.start(parent.id);
    expect([status, task.status, task.error]).toEqual(["started", "failed", "it could not be started"]);
    expect(s.mail(parent.id).map((m) => m.text)).toEqual([
      `[Subagent result] “Find the retry call sites”: failed after ${formatSubagentDuration(durationOf(task))}: it could not be started.`
    ]);
  } finally { s.env.cleanup(); }
});

test("the child's first message is its task, from whoever asked: the thread's title, the worker's feature, or Your agent", () => {
  const s = scene("md-subagents-asker-");
  try {
    const projectId = seedProject(s.env.projects, { name: "project-1" });
    const featureId = seedFeature(s.env.features, projectId, { name: "Parser" });
    const askers = [
      s.env.agentStore.createManagerThread("Release 0.72"),
      s.env.agentStore.getOrCreateThread("worker", featureId),
      s.env.agentStore.getOrCreateGlobalThread()
    ];
    const firstMessages = askers.map((parent) => {
      const { task } = s.start(parent.id);
      const child = s.env.agentStore.getThreadById(task.childThreadId!)!;
      expect([child.scope, child.scopeId]).toEqual(["subagent", task.id]);
      expect(task.type).toBe("general");
      return s.env.agentStore.getMessages(child.id).map((m) => ({ role: m.role, source: m.source, sourceThreadId: m.sourceThreadId, content: m.content }));
    });
    expect(firstMessages).toEqual(askers.map((parent, i) => [{
      role: "user", source: "subagent-task", sourceThreadId: parent.id,
      content: { type: "text", text: "Do this: Find the retry call sites.", metadata: { subagentTask: { taskId: expect.any(String), askedBy: ["Release 0.72", "Parser", "Your agent"][i] } } }
    }]));
    // None of the children is a thread the sidebar lists.
    expect(s.env.agentStore.listOpenManagerThreads().map((t) => t.id)).toEqual([askers[0]!.id]);
  } finally { s.env.cleanup(); }
});

// It is told where its shell starts: its parent's directory, as the runtime
// works it out for the parent's own shell.
test("a subagent's task names its parent's working directory when there is one", () => {
  const env = freshStoresEnv("md-subagents-workdir-");
  const tasks = new BackgroundTaskStore(env.store.db);
  const asked: string[] = [];
  const service = createSubagentService({
    db: env.store.db, tasks, agentStore: env.agentStore, featuresStore: env.features,
    sse: { emit: () => {} },
    wake: () => "wake_1",
    cancelWake: () => ({ status: "running" }),
    runningWakeOf: () => null,
    workingDirOf: (parent) => { asked.push(parent.id); return parent.scope === "manager" ? "/repo/project-1" : null; }
  });
  const manager = env.agentStore.createManagerThread("Release 0.72");
  const { task } = service.start({ parentThreadId: manager.id, title: "Notes", task: "Find the notes." });
  const firstOf = (threadId: string) => env.agentStore.getMessages(threadId).find((m) => m.source === "subagent-task")!;
  expect(subagentTaskOf(firstOf(task.childThreadId!).content)).toEqual({ taskId: task.id, askedBy: "Release 0.72", workingDir: "/repo/project-1" });
  expect(asked).toStrictEqual([manager.id]);
  // Without one, the task names none.
  const global = env.agentStore.getOrCreateGlobalThread();
  const second = service.start({ parentThreadId: global.id, title: "More", task: "Find more." }).task;
  expect(subagentTaskOf(firstOf(second.childThreadId!).content)).toEqual({ taskId: second.id, askedBy: "Your agent" });
});

test("stopping all of a conversation's subagents: the queued at once, the running when their wakes end; nobody is told, nothing starts, another conversation's run on", () => {
  const s = scene("md-subagents-stop-all-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const other = s.env.agentStore.createManagerThread("Docs");
    const runs = Array.from({ length: 8 }, (_, i) => s.start(parent.id, `Job ${i + 1}`).task);
    const elsewhere = s.start(other.id, "Docs survey").task;
    // The scheduler still runs the first one's wake; the others' have ended under it.
    s.running.set(runs[0]!.childThreadId!, "wake_first");
    const wokenBefore = s.woken.length;
    expect(s.service.hasOpenTasks(parent.id)).toBe(true);
    s.service.stopAllFor(parent.id);
    expect(s.canceled).toStrictEqual(["wake_first"]);
    expect(runs.map((t) => s.tasks.get(t.id)!.status)).toEqual(["running", "stopped", "stopped", "stopped", "stopped", "stopped", "stopped", "stopped"]);
    // Its wake ends canceled: the end step records the archive's stop.
    s.childWake(runs[0]!, "canceled");
    expect(runs.map((t) => s.tasks.get(t.id)!.stoppedBy)).toEqual(Array<"archive">(8).fill("archive"));
    // The queued ones never started.
    expect([s.tasks.get(runs[6]!.id)!.startedAt, s.tasks.get(runs[7]!.id)!.startedAt]).toEqual([null, null]);
    expect(s.mail(parent.id)).toEqual([]);
    expect(s.woken.slice(wokenBefore)).toStrictEqual([]);
    expect(s.service.hasOpenTasks(parent.id)).toBe(false);
    expect(s.tasks.get(elsewhere.id)!.status).toBe("running");
    expect(s.service.hasOpenTasks(other.id)).toBe(true);
    // Called again, it finds nothing open and does nothing.
    s.service.stopAllFor(parent.id);
    expect(s.canceled).toStrictEqual(["wake_first"]);
  } finally { s.env.cleanup(); }
});

test("after a restart each running subagent ends interrupted and its open conversation is told, then the queued start; an archived conversation hears nothing and starts nothing", () => {
  const s = scene("md-subagents-recover-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const runs = Array.from({ length: 7 }, (_, i) => s.start(parent.id, `Job ${i + 1}`).task);
    const archived = s.env.agentStore.createManagerThread("Old release");
    const old = s.start(archived.id, "Old survey").task;
    s.env.agentStore.archiveThread(archived.id);
    const wokenBefore = s.woken.length;
    s.service.recoverAtStartup();
    expect(runs.map((t) => s.tasks.get(t.id)!.status)).toEqual([...Array<"interrupted">(6).fill("interrupted"), "running"]);
    expect(s.mail(parent.id).map((m) => [m.metadata.taskId, m.metadata.outcome])).toEqual(runs.slice(0, 6).map((t) => [t.id, "interrupted"]));
    expect(s.mail(parent.id)[0]!.text).toBe("[Subagent result] “Job 1”: was interrupted when Mandate restarted, before it finished. Start it again if you still need it.");
    // Every parent told first, then the queued one started in a slot that left.
    expect(s.woken.slice(wokenBefore)).toStrictEqual([
      ...Array.from({ length: 6 }, (): [string, string] => [parent.id, "subagent-result"]),
      [runs[6]!.childThreadId!, "subagent-task"]
    ]);
    expect(s.tasks.get(old.id)!.status).toBe("interrupted");
    expect(s.mail(archived.id)).toEqual([]);
  } finally { s.env.cleanup(); }
});

test("an archive while a stop is on its way silences it: the run ends stopped by the archive, and nobody is told", () => {
  const s = scene("md-subagents-stop-then-archive-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id, "Map the cache layer").task;
    s.running.set(task.childThreadId!, "wake_user");
    // The user's Stop, then the archive, before the wake has ended.
    expect(s.service.stop(task.id, "user")?.status).toBe("running");
    s.service.stopAllFor(parent.id);
    expect(s.canceled).toStrictEqual(["wake_user"]);
    s.childWake(task, "canceled");
    expect(s.tasks.get(task.id)).toMatchObject({ status: "stopped", stoppedBy: "archive" });
    expect(s.mail(parent.id)).toEqual([]);
    expect(s.woken.filter(([, reason]) => reason === "subagent-result")).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

// Archived by its row alone (an agent's own write to the database, say),
// nothing stopped its subagents: what is left of them must still end, or the
// conversation reads as at work for good and can never be deleted.
test("at start-up an archived conversation's queued subagents end stopped by the archive, after its running ones end interrupted; nobody is told", () => {
  const s = scene("md-subagents-archived-recover-");
  try {
    const parent = s.env.agentStore.createManagerThread("Old release");
    const runs = Array.from({ length: 7 }, (_, i) => s.start(parent.id, `Job ${i + 1}`).task);
    s.env.agentStore.archiveThread(parent.id);
    const wokenBefore = s.woken.length;
    s.service.recoverAtStartup();
    expect(runs.map((t) => [s.tasks.get(t.id)!.status, s.tasks.get(t.id)!.stoppedBy])).toEqual([
      ...Array.from({ length: 6 }, () => ["interrupted" as const, null]),
      ["stopped", "archive"]
    ]);
    expect(s.tasks.get(runs[6]!.id)!.startedAt).toBeNull();
    expect(s.service.hasOpenTasks(parent.id)).toBe(false);
    expect(s.mail(parent.id)).toEqual([]);
    expect(s.woken.slice(wokenBefore)).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

test("when a run of an archived conversation ends, its queued ones end stopped by the archive instead of starting", () => {
  const s = scene("md-subagents-archived-end-");
  try {
    const parent = s.env.agentStore.createManagerThread("Old release");
    const runs = Array.from({ length: 7 }, (_, i) => s.start(parent.id, `Job ${i + 1}`).task);
    s.env.agentStore.archiveThread(parent.id);
    s.childWake(runs[0]!, "finished");
    expect(s.tasks.get(runs[6]!.id)).toMatchObject({ status: "stopped", stoppedBy: "archive", startedAt: null });
    expect(s.woken.filter(([threadId]) => threadId === runs[6]!.childThreadId!)).toStrictEqual([]);
    expect(s.mail(parent.id)).toEqual([]);
  } finally { s.env.cleanup(); }
});

// An agent writing Mandate's database directly is normal: a write the
// database refuses past its busy timeout must not leave a run "running" for
// good, its parent never told. Here the scheduler is a fake that makes real
// wake rows, and the database is held by a second connection.
function busyScene(prefix: string, fail: { wakes?: Partial<Record<string, number>>; cancels?: number } = {}) {
  const env = freshStoresEnv(prefix);
  const tasks = new BackgroundTaskStore(env.store.db);
  const woken: Array<[string, string]> = [];
  const wakesToFail: Partial<Record<string, number>> = { ...fail.wakes };
  let cancelsToFail = fail.cancels ?? 0;
  // Threads the scheduler still holds (a wake being ended, its end retried).
  const busy = new Set<string>();
  const service = createSubagentService({
    db: env.store.db, tasks, agentStore: env.agentStore, featuresStore: env.features,
    sse: { emit: () => {} },
    wake: (threadId, reason) => {
      if ((wakesToFail[reason] ?? 0) > 0) {
        wakesToFail[reason]! -= 1;
        throw new Error("database is locked");
      }
      woken.push([threadId, reason]);
      return env.agentStore.createWake({ threadId, reason, triggerMessageId: null }).id;
    },
    cancelWake: () => {
      if (cancelsToFail > 0) { cancelsToFail -= 1; throw new Error("database is locked"); }
      return { status: "running" };
    },
    runningWakeOf: (threadId) => env.agentStore.getRunningWakeForThread(threadId),
    isThreadBusy: (threadId) => busy.has(threadId),
    retryDelaysMs: []
  });
  const mail = (threadId: string) =>
    (env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'subagent-result' order by rowid").all(threadId) as Array<{ content: string }>)
      .map((row) => JSON.parse(row.content) as { text: string; metadata: Record<string, unknown> });
  /** Another connection holds the database while `fn` runs, past a short busy timeout. */
  const whileHeld = (fn: () => void) => {
    env.store.db.exec("pragma busy_timeout = 50");
    const other = new Database(path.join(env.dir, "mandate.db"));
    other.exec("begin immediate");
    try { fn(); } finally {
      other.exec("rollback");
      other.close();
      env.store.db.exec("pragma busy_timeout = 5000");
    }
  };
  /** The child's wake ends as the scheduler leaves it, with a reply. */
  const finishChild = (task: BackgroundTaskDto, text = "Two call sites.") => {
    const wake = env.agentStore.getRunningWakeForThread(task.childThreadId!)!;
    env.agentStore.appendMessage({ threadId: task.childThreadId!, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text } });
    env.agentStore.finishWake(wake.id, "finished", null);
    return wake.id;
  };
  const start = (parentThreadId: string) => service.start({ parentThreadId, title: "Find the retry call sites", task: "List them." }).task;
  return { env, tasks, service, woken, busy, mail, whileHeld, finishChild, start };
}

test("an end step the database refused leaves nothing half done, and a reconcile ends the run as its wake did, its parent told once", () => {
  const s = busyScene("md-subagents-busy-end-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id);
    const wakeId = s.finishChild(task);
    // Refused: logged, not thrown, and neither its end nor its mail written.
    s.whileHeld(() => { expect(() => s.service.onChildWakeEnded(task.childThreadId!, { wakeId, status: "finished" })).not.toThrow(); });
    expect([s.tasks.get(task.id)!.status, s.mail(parent.id).length]).toEqual(["running", 0]);
    s.service.reconcile();
    expect([s.tasks.get(task.id)!.status, s.tasks.replyOf(task.id)]).toEqual(["finished", "Two call sites."]);
    expect(s.mail(parent.id).map((m) => m.metadata.outcome)).toStrictEqual(["finished"]);
    expect(s.woken.filter(([, reason]) => reason === "subagent-result")).toStrictEqual([[parent.id, "subagent-result"]]);
    // Again: nothing more.
    s.service.reconcile();
    expect(s.mail(parent.id)).toHaveLength(1);
  } finally { s.env.cleanup(); }
});

test("a run whose child wake could not be made is started again by a reconcile", () => {
  const s = busyScene("md-subagents-busy-start-", { wakes: { "subagent-task": 1 } });
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id);
    expect([s.tasks.get(task.id)!.status, s.env.agentStore.getLatestWakeForThread(task.childThreadId!) === null]).toEqual(["running", true]);
    s.service.reconcile();
    expect(s.woken).toStrictEqual([[task.childThreadId!, "subagent-task"]]);
    expect(s.env.agentStore.getRunningWakeForThread(task.childThreadId!) !== null).toBe(true);
  } finally { s.env.cleanup(); }
});

test("a queued run left waiting with a free slot starts at a reconcile", () => {
  const s = busyScene("md-subagents-busy-queue-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    // As a refused start leaves one: queued, nothing running.
    const taskId = "task_left_queued";
    const child = s.env.agentStore.createSubagentThread(taskId);
    s.tasks.create({ id: taskId, parentThreadId: parent.id, childThreadId: child.id, type: "general", title: "Left waiting", task: "Do it." });
    s.service.reconcile();
    expect(s.tasks.get(taskId)!.status).toBe("running");
    expect(s.woken).toStrictEqual([[child.id, "subagent-task"]]);
  } finally { s.env.cleanup(); }
});

test("a parent whose wake for a result could not be made is woken by a reconcile, once", () => {
  const s = busyScene("md-subagents-busy-parent-", { wakes: { "subagent-result": 1 } });
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id);
    const wakeId = s.finishChild(task);
    expect(() => s.service.onChildWakeEnded(task.childThreadId!, { wakeId, status: "finished" })).not.toThrow();
    expect([s.tasks.get(task.id)!.status, s.mail(parent.id).length]).toEqual(["finished", 1]);
    expect(s.woken.filter(([, reason]) => reason === "subagent-result")).toStrictEqual([]);
    s.service.reconcile();
    s.service.reconcile();
    expect(s.woken.filter(([, reason]) => reason === "subagent-result")).toStrictEqual([[parent.id, "subagent-result"]]);
  } finally { s.env.cleanup(); }
});

test("a stop whose cancel the database refused is not kept: the run then ends as its wake did, and its parent is told", () => {
  const s = busyScene("md-subagents-busy-stop-", { cancels: 1 });
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id);
    expect(() => s.service.stop(task.id, "agent", parent.id)).toThrow("database is locked");
    const wakeId = s.finishChild(task);
    s.service.onChildWakeEnded(task.childThreadId!, { wakeId, status: "finished" });
    expect(s.tasks.get(task.id)).toMatchObject({ status: "finished", stoppedBy: null });
    expect(s.mail(parent.id).map((m) => m.metadata.outcome)).toStrictEqual(["finished"]);
  } finally { s.env.cleanup(); }
});

test("a refused end step is tried again by itself after the delays it is given", async () => {
  const env = freshStoresEnv("md-subagents-busy-retry-");
  const tasks = new BackgroundTaskStore(env.store.db);
  const service = createSubagentService({
    db: env.store.db, tasks, agentStore: env.agentStore, featuresStore: env.features,
    sse: { emit: () => {} },
    wake: (threadId, reason) => env.agentStore.createWake({ threadId, reason, triggerMessageId: null }).id,
    cancelWake: () => ({ status: "running" }),
    runningWakeOf: (threadId) => env.agentStore.getRunningWakeForThread(threadId),
    retryDelaysMs: [5, 5]
  });
  onCleanupService(service);
  const parent = env.agentStore.createManagerThread("Release 0.72");
  const { task } = service.start({ parentThreadId: parent.id, title: "Find the retry call sites", task: "List them." });
  const wake = env.agentStore.getRunningWakeForThread(task.childThreadId!)!;
  env.agentStore.finishWake(wake.id, "finished", null);
  env.store.db.exec("pragma busy_timeout = 20");
  const other = new Database(path.join(env.dir, "mandate.db"));
  other.exec("begin immediate");
  service.onChildWakeEnded(task.childThreadId!, { wakeId: wake.id, status: "finished" });
  other.exec("rollback");
  other.close();
  env.store.db.exec("pragma busy_timeout = 5000");
  await waitUntil(() => tasks.get(task.id)!.status === "finished", { label: "the end step tried again" });
});

test("a run's end and its result's mail are one write: the mail refused, its end is not kept either, and a reconcile writes both", () => {
  const s = busyScene("md-subagents-busy-atomic-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id);
    const wakeId = s.finishChild(task);
    const enqueue = s.env.agentStore.enqueueMailboxMessage.bind(s.env.agentStore);
    let refuse = true;
    s.env.agentStore.enqueueMailboxMessage = ((input: Parameters<typeof enqueue>[0]) => {
      if (refuse) { refuse = false; throw new Error("database is locked"); }
      return enqueue(input);
    }) as typeof enqueue;
    s.service.onChildWakeEnded(task.childThreadId!, { wakeId, status: "finished" });
    expect([s.tasks.get(task.id)!.status, s.mail(parent.id).length]).toEqual(["running", 0]);
    s.service.reconcile();
    expect([s.tasks.get(task.id)!.status, s.mail(parent.id).length]).toEqual(["finished", 1]);
  } finally { s.env.cleanup(); }
});

test("a stop on its way outlives a refused end step: the reconcile ends the run stopped by its agent, and tells nobody", () => {
  const s = busyScene("md-subagents-busy-pending-stop-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id);
    expect(s.service.stop(task.id, "agent", parent.id)?.status).toBe("running");
    const wakeId = s.finishChild(task);
    s.whileHeld(() => { s.service.onChildWakeEnded(task.childThreadId!, { wakeId, status: "canceled" }); });
    s.service.reconcile();
    expect(s.tasks.get(task.id)).toMatchObject({ status: "stopped", stoppedBy: "agent" });
    expect(s.mail(parent.id)).toEqual([]);
  } finally { s.env.cleanup(); }
});

// Its wake row says ended while the scheduler still ends it (a later write
// of the end, a cut-off row, refused and retried): its end step is coming.
test("a reconcile leaves alone a run whose child the scheduler still holds, though its wake's row has ended", () => {
  const s = busyScene("md-subagents-busy-held-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id);
    s.finishChild(task);
    s.busy.add(task.childThreadId!);
    s.service.reconcile();
    expect([s.tasks.get(task.id)!.status, s.mail(parent.id).length]).toEqual(["running", 0]);
    s.busy.delete(task.childThreadId!);
    s.service.reconcile();
    expect(s.tasks.get(task.id)!.status).toBe("finished");
  } finally { s.env.cleanup(); }
});

test("a parent whose result another turn has read already is not woken again for it", () => {
  const s = busyScene("md-subagents-busy-read-", { wakes: { "subagent-result": 1 } });
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const task = s.start(parent.id);
    const wakeId = s.finishChild(task);
    s.service.onChildWakeEnded(task.childThreadId!, { wakeId, status: "finished" });
    // A turn the user started read it meanwhile.
    const turn = s.env.agentStore.createWake({ threadId: parent.id, reason: "user", triggerMessageId: null });
    s.env.agentStore.drainMailboxToMessages(parent.id, turn.id);
    s.env.agentStore.finishWake(turn.id, "finished", null);
    s.service.reconcile();
    expect(s.woken.filter(([, reason]) => reason === "subagent-result")).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

test("disposed, a refused end step is not tried again", async () => {
  const env = freshStoresEnv("md-subagents-busy-disposed-");
  const tasks = new BackgroundTaskStore(env.store.db);
  const service = createSubagentService({
    db: env.store.db, tasks, agentStore: env.agentStore, featuresStore: env.features,
    sse: { emit: () => {} },
    wake: (threadId, reason) => env.agentStore.createWake({ threadId, reason, triggerMessageId: null }).id,
    cancelWake: () => ({ status: "running" }),
    runningWakeOf: (threadId) => env.agentStore.getRunningWakeForThread(threadId),
    retryDelaysMs: [5, 5]
  });
  const parent = env.agentStore.createManagerThread("Release 0.72");
  const { task } = service.start({ parentThreadId: parent.id, title: "Find the retry call sites", task: "List them." });
  const wake = env.agentStore.getRunningWakeForThread(task.childThreadId!)!;
  env.agentStore.finishWake(wake.id, "finished", null);
  service.dispose();
  env.store.db.exec("pragma busy_timeout = 20");
  const other = new Database(path.join(env.dir, "mandate.db"));
  other.exec("begin immediate");
  service.onChildWakeEnded(task.childThreadId!, { wakeId: wake.id, status: "finished" });
  other.exec("rollback");
  other.close();
  env.store.db.exec("pragma busy_timeout = 5000");
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(tasks.get(task.id)!.status).toBe("running");
});

// A command is a background task too, but not the subagents' to run: it takes
// no slot of theirs, and their queue, reconcile, restart and archive leave it be.
test("a running command of the conversation takes no subagent's slot and is never ended, woken or interrupted by the subagent service", () => {
  const s = scene("md-sub-cmd-");
  onCleanupService(s.service);
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const cmd = s.tasks.createCommand({ parentThreadId: parent.id, title: "e2e", command: "make e2e", outputPath: "/tmp/e2e.log", pid: null, startedAt: new Date().toISOString() });
    const runs = Array.from({ length: 6 }, (_, i) => s.start(parent.id, `Job ${i + 1}`));
    expect(runs.map((r) => r.status)).toEqual(["started", "started", "started", "started", "started", "started"]);
    // A seventh waits for a subagent's slot, and takes the one a subagent frees.
    const seventh = s.start(parent.id, "Job 7");
    expect(seventh.status).toBe("queued");
    s.childWake(runs[0]!.task, "finished", (wakeId) => { s.say(runs[0]!.task, wakeId, "Done."); });
    expect(s.tasks.get(seventh.task.id)!.status).toBe("running");
    expect(s.service.stop(cmd.id, "user")).toBeNull();
    s.service.reconcile();
    s.service.recoverAtStartup();
    s.service.stopAllFor(parent.id);
    expect(s.tasks.get(cmd.id)!.status).toBe("running");
    expect(s.service.hasOpenTasks(parent.id)).toBe(true);
  } finally { s.env.cleanup(); }
});

test("a queued run the user stops never ran: its result counts no time, however long it waited", () => {
  let at = Date.parse("2026-10-19T10:00:00.000Z");
  const s = scene("md-subagents-queued-time-", { now: () => new Date(at) });
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const runs = Array.from({ length: 7 }, (_, i) => s.start(parent.id, `Job ${i + 1}`));
    const seventh = runs[6]!.task;
    expect(runs[6]!.status).toBe("queued");
    at += 90_000;
    s.service.stop(seventh.id, "user");
    const [result] = s.mail(parent.id);
    expect(result!.text).toBe("[Subagent result] “Job 7”: stopped by the user after 0s, before it finished.");
    expect(result!.metadata.durationMs).toBe(0);
  } finally { s.env.cleanup(); }
});

test("a run cut short by a restart counts its time up to its last step, not the time Mandate was down", () => {
  const t0 = Date.parse("2026-10-19T10:00:00.000Z");
  let at = t0;
  const s = scene("md-subagents-interrupted-time-", { now: () => new Date(at) });
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const runs = Array.from({ length: 7 }, (_, i) => s.start(parent.id, `Job ${i + 1}`).task);
    const [task, quiet] = [runs[0]!, runs[1]!];
    const late = runs[6]!;
    // The store writes its own clock's time: each child's task as given at the start.
    const timed = (threadId: string, iso: string) => s.env.store.db.prepare("update agent_messages set created_at = ? where thread_id = ?").run(iso, threadId);
    for (const run of runs) timed(run.childThreadId!, new Date(t0).toISOString());
    // The queued one starts five minutes in, when a slot frees: its task was given before.
    at = t0 + 300_000;
    s.service.stop(runs[5]!.id, "agent", parent.id);
    s.childWake(runs[5]!, "canceled");
    expect(s.tasks.get(late.id)!.startedAt).toBe(new Date(t0 + 300_000).toISOString());
    // Its last step, ten minutes in.
    const wake = s.env.agentStore.createWake({ threadId: task.childThreadId!, reason: "subagent-task", triggerMessageId: null });
    const step = s.say(task, wake.id, "Reading the call sites…");
    s.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(t0 + 600_000).toISOString(), step.id);
    // Mandate was down an hour.
    at = t0 + 600_000 + 3_600_000;
    s.service.recoverAtStartup();
    const byTask = new Map(s.mail(parent.id).map((m) => [m.metadata.taskId, m.metadata.durationMs]));
    expect([byTask.get(task.id), byTask.get(quiet.id), byTask.get(late.id)]).toEqual([600_000, 0, 0]);
    expect(s.tasks.get(task.id)!).toMatchObject({ status: "interrupted", finishedAt: new Date(t0 + 600_000).toISOString() });
    // Its end is not before its start.
    expect(s.tasks.get(late.id)!.finishedAt).toBe(new Date(t0 + 300_000).toISOString());
  } finally { s.env.cleanup(); }
});
