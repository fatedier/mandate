import { expect, test } from "bun:test";
import { BackgroundTaskStore } from "../../src/server/modules/agent/background-task-store.js";
import { createSubagentService } from "../../src/server/runtime/subagents.js";
import { BACKGROUND_TASKS_PAGE, type BackgroundTaskDto } from "../../src/shared/api-contracts.js";
import { formatSubagentDuration } from "../../src/shared/subagent-messages.js";
import { buildAgentsTestApp, buildTestScopes, getJson, postJson } from "../helpers/test-app.js";
import { freshStoresEnv, NOOP_WAKE } from "../helpers/fixtures.js";
import { readOutputTail } from "../../src/server/platform/process/output-tail.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The "Background tasks" list reads a thread's runs, newest first, and its
// Stop is the user's. The scheduler is a fake: every wake is taken, none runs,
// so a running run has no wake to cancel and ends at the request.

function scene(prefix: string) {
  const env = freshStoresEnv(prefix);
  const tasks = new BackgroundTaskStore(env.store.db);
  const woken: Array<[string, string]> = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const service = createSubagentService({
    db: env.store.db, tasks, agentStore: env.agentStore, featuresStore: env.features,
    sse: { emit: (event: string, data: unknown) => { events.push({ event, data }); } },
    wake: (threadId, reason) => { woken.push([threadId, reason]); return `wake_${woken.length}`; },
    cancelWake: () => ({ status: "canceled" }),
    runningWakeOf: () => null
  });
  const app = buildAgentsTestApp({
    agentStore: env.agentStore, wakeScheduler: NOOP_WAKE, scopes: buildTestScopes(env.features),
    backgroundTasks: {
      get: (id) => tasks.get(id),
      detailOf: (id) => {
        const brief = tasks.taskText(id);
        return brief === null ? null : { brief, reply: tasks.replyOf(id) };
      },
      pageForThread: (id, before) => tasks.pageForThread(id, { before, limit: BACKGROUND_TASKS_PAGE }),
      changedSince: (id, since) => tasks.changedSince(id, since),
      stop: (id) => service.stop(id, "user"),
      commandOutput: (id) => {
        const task = tasks.get(id);
        const tail = task?.outputPath ? readOutputTail(task.outputPath, { tailMaxLines: 2000, tailMaxBytes: 51_200 }, null) : null;
        return task && tail ? { ...tail, path: task.outputPath! } : null;
      }
    }
  });
  const mail = (threadId: string) =>
    (env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'subagent-result' order by rowid").all(threadId) as Array<{ content: string }>)
      .map((row) => (JSON.parse(row.content) as { text: string }).text);
  const durationOf = (task: BackgroundTaskDto) => Date.parse(task.finishedAt!) - Date.parse(task.startedAt ?? task.createdAt);
  return { env, tasks, service, app, woken, events, mail, durationOf };
}

test("a thread's tasks are listed newest first, with the number the read reflects; what changed after it is read with since; an unknown thread is not found", async () => {
  const s = scene("md-tasks-api-list-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const first = s.service.start({ parentThreadId: parent.id, title: "First", task: "Do the first." }).task;
    const second = s.service.start({ parentThreadId: parent.id, title: "Second", task: "Do the second." }).task;
    const listed = await getJson(s.app, `/api/agents/threads/${parent.id}/tasks`);
    expect([listed.status, (listed.body.tasks as BackgroundTaskDto[]).map((t) => [t.id, t.status]), listed.body.olderDone, listed.body.seq, Object.hasOwn(listed.body, "total")])
      .toEqual([200, [[second.id, "running"], [first.id, "running"]], null, s.tasks.get(second.id)!.seq, false]);
    const stopped = await postJson(s.app, `/api/agents/tasks/${first.id}/stop`, {});
    const third = s.service.start({ parentThreadId: parent.id, title: "Third", task: "Do the third." }).task;
    const changed = await getJson(s.app, `/api/agents/threads/${parent.id}/tasks?since=${listed.body.seq as number}`);
    expect([changed.status, (changed.body.tasks as BackgroundTaskDto[]).map((t) => [t.id, t.status]), changed.body.seq])
      .toEqual([200, [[first.id, "stopped"], [third.id, "running"]], s.tasks.get(third.id)!.seq]);
    expect(stopped.status).toBe(200);
    expect(await getJson(s.app, `/api/agents/threads/${parent.id}/tasks?since=later`)).toEqual({ status: 400, body: { error: "since must be a whole number" } });
    expect(await getJson(s.app, "/api/agents/threads/thr_missing/tasks")).toEqual({ status: 404, body: { error: "thread not found" } });
  } finally { s.env.cleanup(); }
});

test("the list reads the done tasks fifty at a time after the open ones, and a task by its id; none carries its reply", async () => {
  const s = scene("md-tasks-api-pages-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const done = Array.from({ length: BACKGROUND_TASKS_PAGE + 2 }, (_, i) => {
      const { task } = s.service.start({ parentThreadId: parent.id, title: `Done ${i + 1}`, task: `Do ${i + 1}.` });
      // Ended in order, a second apart: the last to end is the latest.
      return s.tasks.finish(task.id, { status: "finished", reply: "A long reply.", error: null, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })!;
    });
    const running = s.service.start({ parentThreadId: parent.id, title: "Still at it", task: "Keep going." }).task;
    const first = await getJson(s.app, `/api/agents/threads/${parent.id}/tasks`);
    const ids = (first.body.tasks as BackgroundTaskDto[]).map((t) => t.id);
    expect([ids.length, ids[0], ids[1], ids.at(-1)])
      .toEqual([BACKGROUND_TASKS_PAGE + 1, running.id, done.at(-1)!.id, done[2]!.id]);
    expect((first.body.tasks as Array<Record<string, unknown>>).some((t) => Object.hasOwn(t, "reply"))).toBe(false);
    const older = await getJson(s.app, `/api/agents/threads/${parent.id}/tasks?before=${encodeURIComponent(first.body.olderDone as string)}`);
    expect([(older.body.tasks as BackgroundTaskDto[]).map((t) => t.id), older.body.olderDone]).toEqual([[done[1]!.id, done[0]!.id], null]);
    const one = await getJson(s.app, `/api/agents/tasks/${done[0]!.id}`);
    expect([one.status, one.body.task.id, one.body.task.title, Object.hasOwn(one.body.task, "reply")]).toEqual([200, done[0]!.id, "Done 1", false]);
    expect(await getJson(s.app, "/api/agents/tasks/task_missing")).toEqual({ status: 404, body: { error: "task not found" } });
  } finally { s.env.cleanup(); }
});

test("the user's Stop ends a running task, its conversation is told and woken; a second Stop and an unknown task are refused", async () => {
  const s = scene("md-tasks-api-stop-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const { task } = s.service.start({ parentThreadId: parent.id, title: "Map the cache layer", task: "Map the cache layer." });
    const stopped = await postJson(s.app, `/api/agents/tasks/${task.id}/stop`, {});
    expect([stopped.status, stopped.body.task.id, stopped.body.task.status, stopped.body.task.stoppedBy]).toEqual([200, task.id, "stopped", "user"]);
    expect(s.mail(parent.id)).toEqual([
      `[Subagent result] “Map the cache layer”: stopped by the user after ${formatSubagentDuration(s.durationOf(s.tasks.get(task.id)!))}, before it finished.`
    ]);
    expect(s.woken.at(-1)).toEqual([parent.id, "subagent-result"]);
    expect(await postJson(s.app, `/api/agents/tasks/${task.id}/stop`, {})).toEqual({ status: 409, body: { error: "task is already stopped" } });
    expect(await postJson(s.app, "/api/agents/tasks/task_missing/stop", {})).toEqual({ status: 404, body: { error: "task not found" } });
  } finally { s.env.cleanup(); }
});

test("the user's Stop of a queued task: it never starts, its conversation is told, and the change is announced", async () => {
  const s = scene("md-tasks-api-queued-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const runs = Array.from({ length: 7 }, (_, i) =>
      s.service.start({ parentThreadId: parent.id, title: `Job ${i + 1}`, task: `Do job ${i + 1}.` }));
    const seventh = runs[6]!;
    expect(seventh.status).toBe("queued");
    const stopped = await postJson(s.app, `/api/agents/tasks/${seventh.task.id}/stop`, {});
    expect([stopped.status, stopped.body.task.status, stopped.body.task.startedAt]).toEqual([200, "stopped", null]);
    expect(s.woken.filter(([threadId]) => threadId === seventh.task.childThreadId!)).toStrictEqual([]);
    expect(s.mail(parent.id)).toEqual([
      `[Subagent result] “Job 7”: stopped by the user after ${formatSubagentDuration(s.durationOf(s.tasks.get(seventh.task.id)!))}, before it finished.`
    ]);
    // Each change carries the task as it now is, with its number.
    const announced = s.events
      .filter((e) => e.event === "backgroundTaskChanged" && (e.data as { task: BackgroundTaskDto }).task.id === seventh.task.id)
      .map((e) => (e.data as { task: BackgroundTaskDto }).task);
    expect([announced.map((t) => t.status), announced[0]!.seq < announced[1]!.seq, announced[1]!.seq]).toEqual([["queued", "stopped"], true, s.tasks.get(seventh.task.id)!.seq]);
  } finally { s.env.cleanup(); }
});

// A task's detail: what it was asked (its brief), what it answered (its
// reply, none while it runs), and how many calls it made, without its steps.
test("a task's detail reads its brief, its reply once it has one, and how many calls it made", async () => {
  const s = scene("md-tasks-api-detail-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const { task } = s.service.start({ parentThreadId: parent.id, title: "Find the retry call sites", task: "List every call site of retryWake.\n\nDo not edit any file." });
    const child = task.childThreadId!;
    const say = (toolCalls: number) => s.env.agentStore.appendMessage({ threadId: child, role: "assistant", source: "self", content: {
      type: "assistant", text: "", toolCalls: Array.from({ length: toolCalls }, (_, i) => ({ toolCallId: `k${i}-${toolCalls}`, toolName: "read", args: { path: `/repo/f${i}.ts` } }))
    } });
    say(2);
    say(1);
    const running = await getJson(s.app, `/api/agents/tasks/${task.id}`);
    expect([running.body.brief, running.body.reply, running.body.stepCount, running.body.task.status])
      .toEqual(["List every call site of retryWake.\n\nDo not edit any file.", null, 3, "running"]);
    s.tasks.finish(task.id, { status: "finished", reply: "Two call sites.", error: null, at: new Date().toISOString() });
    const ended = await getJson(s.app, `/api/agents/tasks/${task.id}`);
    expect([ended.body.reply, ended.body.task.status]).toEqual(["Two call sites.", "finished"]);
  } finally { s.env.cleanup(); }
});

test("a command's detail reads the command, the end of its output now, and how much there is; one whose file is gone keeps its stored end", async () => {
  const s = scene("md-tasks-api-command-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "tasks-api-cmd-")), "task.log");
    writeFileSync(file, "one\ntwo\nthree\n");
    const task = s.tasks.createCommand({ parentThreadId: parent.id, title: "Run the e2e suite", command: "make e2e", outputPath: file, pid: null, startedAt: new Date().toISOString() });
    const running = await getJson(s.app, `/api/agents/tasks/${task.id}`);
    expect(running.body).toEqual({
      task: expect.objectContaining({ id: task.id, kind: "command", status: "running" }),
      brief: "make e2e", reply: "one\ntwo\nthree", stepCount: 0,
      output: { shownLines: 3, totalLines: 3, bytes: 14, path: file }
    });
    s.tasks.finishCommand(task.id, { status: "failed", exitCode: 1, reply: "three", error: "exit 1", at: new Date().toISOString() });
    const gone = s.tasks.createCommand({ parentThreadId: parent.id, title: "Gone", command: "make gone", outputPath: path.join(path.dirname(file), "missing.log"), pid: null, startedAt: new Date().toISOString() });
    s.tasks.finishCommand(gone.id, { status: "finished", exitCode: 0, reply: "the stored end", error: null, at: new Date().toISOString() });
    const read = await getJson(s.app, `/api/agents/tasks/${gone.id}`);
    expect([read.body.brief, read.body.reply, read.body.stepCount, read.body.output]).toEqual(["make gone", "the stored end", 0, { shownLines: 0, totalLines: 0, bytes: 0, path: path.join(path.dirname(file), "missing.log") }]);
  } finally { s.env.cleanup(); }
});
