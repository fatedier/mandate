import { expect, test } from "bun:test";
import { MandateStore } from "../src/server/app/store.js";
import { BackgroundTaskStore, RUNNING_OUTPUT_PATHS_SQL } from "../src/server/modules/agent/background-task-store.js";
import { API_PATHS, BACKGROUND_TASKS_PAGE } from "../src/shared/api-contracts.js";
import { onCleanup } from "./helpers/cleanup.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

function setup() {
  const env = freshStoresEnv("md-background-tasks-");
  onCleanup(env.cleanup);
  const tasks = new BackgroundTaskStore(env.store.db);
  let n = 0;
  /** A task of `parentThreadId`, with a child thread of its own. */
  const start = (parentThreadId: string) => {
    n += 1;
    return tasks.create({
      parentThreadId,
      childThreadId: `thr_child_${n}`,
      type: "general",
      title: `Job ${n}`,
      task: `Do job ${n}.`
    });
  };
  return { ...env, tasks, start };
}

const ENDED_AT = "2026-01-01T00:05:00.000Z";

test("a task starts queued, with its parent, its child's thread, type and title and no outcome; its text is kept beside it", () => {
  const s = setup();
  const task = s.tasks.create({
    parentThreadId: "thr_parent",
    childThreadId: "thr_child",
    type: "general",
    title: "Find the retry call sites",
    task: "Find every call site of retryWake under src/server and list them with file and line."
  });
  expect(task).toEqual({
    id: expect.stringMatching(/^task_/),
    kind: "subagent",
    parentThreadId: "thr_parent",
    childThreadId: "thr_child",
    type: "general",
    title: "Find the retry call sites",
    status: "queued",
    stoppedBy: null,
    error: null,
    createdAt: expect.any(String),
    startedAt: null,
    finishedAt: null,
    seq: expect.any(Number),
    exitCode: null,
    command: null,
    outputPath: null
  });
  expect(s.tasks.get(task.id)).toEqual(task);
  expect(s.tasks.getByChildThread("thr_child")).toEqual(task);
  expect(s.tasks.taskText(task.id)).toBe("Find every call site of retryWake under src/server and list them with file and line.");
  expect(s.tasks.get("task_missing")).toBeNull();
  expect(s.tasks.getByChildThread("thr_missing")).toBeNull();
  expect(s.tasks.taskText("task_missing")).toBeNull();
});

test("a task takes the id its child's thread was made for, and a child's thread belongs to one task", () => {
  const s = setup();
  const task = s.tasks.create({ id: "task_given", parentThreadId: "thr_parent", childThreadId: "thr_child", type: "general", title: "t", task: "x" });
  expect(task.id).toBe("task_given");
  expect(() => s.tasks.create({ parentThreadId: "thr_parent", childThreadId: "thr_child", type: "general", title: "t2", task: "y" })).toThrow();
});

// What a person cares about is what still runs: a conversation's list reads
// its open tasks whole and its done ones a page at a time, the latest to end
// first; the count is of all of them.
test("a conversation's list: its open tasks, newest first, then its done ones a page at a time, the latest to end first; another conversation's are not among them", () => {
  const s = setup();
  const end = (id: string, at: string) => s.tasks.finish(id, { status: "finished", reply: "Done.", error: null, at });
  const d1 = s.start("thr_a");
  const d2 = s.start("thr_a");
  const d3 = s.start("thr_a");
  const d4 = s.start("thr_a");
  const d5 = s.start("thr_a");
  const b1 = s.start("thr_b");
  end(d1.id, "2026-01-01T00:01:00.000Z");
  // Two ended in one millisecond: their ids order them, and no page loses one.
  end(d2.id, "2026-01-01T00:03:00.000Z");
  end(d3.id, "2026-01-01T00:03:00.000Z");
  end(d4.id, "2026-01-01T00:02:00.000Z");
  end(d5.id, "2026-01-01T00:04:00.000Z");
  const q1 = s.start("thr_a");
  const r1 = s.start("thr_a");
  s.tasks.markRunning(r1.id, "2026-01-01T00:05:00.000Z");
  const tied = [d2.id, d3.id].sort().reverse();
  const first = s.tasks.pageForThread("thr_a", { before: null, limit: 2 });
  expect(first.tasks.map((t) => t.id)).toEqual([r1.id, q1.id, d5.id, tied[0]]);
  expect(first.olderDone).toEqual(expect.any(String));
  const second = s.tasks.pageForThread("thr_a", { before: first.olderDone, limit: 2 });
  expect(second.tasks.map((t) => t.id)).toEqual([tied[1], d4.id]);
  const third = s.tasks.pageForThread("thr_a", { before: second.olderDone, limit: 2 });
  expect([third.tasks.map((t) => t.id), third.olderDone]).toEqual([[d1.id], null]);
  // A page that holds the last of them says none is left.
  expect(s.tasks.pageForThread("thr_a", { before: first.olderDone, limit: 3 }).olderDone).toBeNull();
  // What is not such a point reads from the start of the done ones.
  for (const cursor of ["not-a-cursor", "|" + d5.id, "2026-01-01T00:04:00.000Z|"]) {
    expect(s.tasks.pageForThread("thr_a", { before: cursor, limit: 2 }).tasks.map((t) => t.id)).toEqual([d5.id, tied[0]]);
  }
  expect(s.tasks.pageForThread("thr_b", { before: null, limit: 2 }).tasks.map((t) => t.id)).toEqual([b1.id]);
  expect(s.tasks.pageForThread("thr_none", { before: null, limit: 2 })).toEqual({ tasks: [], olderDone: null, seq: s.tasks.get(r1.id)!.seq });
});

// As a conversation's messages carry their seq, every change of a task takes
// the next number of all tasks: a copy with a greater one is the later, and
// a page says the greatest it reflects, so what changed after it can be read.
test("each change of a task takes the next number of all tasks; a conversation's changes after a number are read in that order, with the number the read reflects", () => {
  const s = setup();
  const a = s.start("thr_a");
  const b = s.start("thr_b");
  const page = s.tasks.pageForThread("thr_a", { before: null, limit: 5 });
  expect([page.seq, a.seq < b.seq, page.seq]).toEqual([b.seq, true, s.tasks.changedSince("thr_a", 0).seq]);
  const running = s.tasks.markRunning(a.id, "2026-01-01T00:01:00.000Z");
  const c = s.start("thr_a");
  const ended = s.tasks.finish(a.id, { status: "finished", reply: "Done.", error: null, at: ENDED_AT })!;
  expect([running.seq > b.seq, c.seq > running.seq, ended.seq > c.seq]).toEqual([true, true, true]);
  // A change that did not happen (an end after the end) takes no number.
  expect(s.tasks.finish(a.id, { status: "stopped", stoppedBy: "user", reply: null, error: null, at: ENDED_AT })).toBeNull();
  expect(s.tasks.get(a.id)!.seq).toBe(ended.seq);
  const changes = s.tasks.changedSince("thr_a", page.seq);
  expect([changes.tasks.map((t) => [t.id, t.status, t.seq]), changes.seq]).toEqual([[[c.id, "queued", c.seq], [a.id, "finished", ended.seq]], ended.seq]);
  expect(s.tasks.changedSince("thr_a", ended.seq)).toEqual({ tasks: [], seq: ended.seq });
  expect(s.tasks.changedSince("thr_b", page.seq).tasks).toEqual([]);
});

// A read's number must stay below every later change, though rows go: a
// deleted conversation takes its tasks with it.
test("a change after other conversations' tasks were deleted still takes a number past every read before it", () => {
  const s = setup();
  const a = s.start("thr_a");
  const b = s.start("thr_b");
  s.tasks.finish(b.id, { status: "finished", reply: null, error: null, at: ENDED_AT });
  const read = s.tasks.pageForThread("thr_a", { before: null, limit: 5 });
  s.store.db.prepare("delete from background_tasks where parent_thread_id = ?").run("thr_b");
  const ended = s.tasks.finish(a.id, { status: "finished", reply: null, error: null, at: ENDED_AT })!;
  expect(ended.seq > read.seq).toBe(true);
  expect(s.tasks.changedSince("thr_a", read.seq).tasks.map((t) => [t.id, t.status])).toEqual([[a.id, "finished"]]);
  expect(s.tasks.pageForThread("thr_a", { before: null, limit: 5 }).seq).toBe(ended.seq);
});

test("on a database whose tasks were numbered before the count was kept, the count starts past them", () => {
  const s = setup();
  const a = s.start("thr_a");
  s.store.db.exec("drop table background_task_seq");
  s.store.db.prepare("update background_tasks set seq = 41 where id = ?").run(a.id);
  const again = new MandateStore(s.dir);
  try {
    const tasks = new BackgroundTaskStore(again.db);
    expect(tasks.markRunning(a.id, "2026-01-01T00:01:00.000Z").seq).toBe(42);
  } finally {
    again.db.close();
  }
});

test("a task as the list and its events carry it: simple facts, never the reply", () => {
  const s = setup();
  const task = s.start("thr_a");
  const ended = s.tasks.finish(task.id, { status: "finished", reply: "x".repeat(20_000), error: null, at: ENDED_AT })!;
  expect(Object.hasOwn(ended, "reply")).toBe(false);
  expect(Object.hasOwn(s.tasks.pageForThread("thr_a", { before: null, limit: 5 }).tasks[0]!, "reply")).toBe(false);
});

test("the queue reads one conversation's oldest queued task and counts only its running ones", () => {
  const s = setup();
  const a1 = s.start("thr_a");
  const a2 = s.start("thr_a");
  const b1 = s.start("thr_b");
  expect(s.tasks.oldestQueued("thr_a")?.id).toBe(a1.id);
  expect(s.tasks.markRunning(a1.id, "2026-01-01T00:00:00.000Z")).toMatchObject({ id: a1.id, status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
  expect(s.tasks.countRunning("thr_a")).toBe(1);
  expect(s.tasks.countRunning("thr_b")).toBe(0);
  expect(s.tasks.oldestQueued("thr_a")?.id).toBe(a2.id);
  expect(s.tasks.oldestQueued("thr_b")?.id).toBe(b1.id);
  // A task stopped while it waited never starts, and nothing is left in line.
  s.tasks.finish(a2.id, { status: "stopped", stoppedBy: "user", reply: null, error: null, at: ENDED_AT });
  expect(s.tasks.markRunning(a2.id, "2026-01-01T00:06:00.000Z")).toMatchObject({ id: a2.id, status: "stopped", startedAt: null });
  expect(s.tasks.oldestQueued("thr_a")).toBeNull();
  expect(s.tasks.countRunning("thr_a")).toBe(1);
  expect(() => s.tasks.markRunning("task_missing", ENDED_AT)).toThrow("background task not found: task_missing");
});

test("a task ends once: its status, who stopped it and its error; a later end changes nothing", () => {
  const s = setup();
  const task = s.start("thr_a");
  s.tasks.markRunning(task.id, "2026-01-01T00:00:00.000Z");
  // Who stopped a task is kept only for a stopped one.
  const ended = s.tasks.finish(task.id, {
    status: "finished", stoppedBy: "user", reply: "Two call sites, both in the wake path.", error: null, at: "2026-01-01T00:04:12.000Z"
  });
  expect(ended).toMatchObject({
    status: "finished", stoppedBy: null, error: null,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:04:12.000Z"
  });
  expect(s.tasks.finish(task.id, { status: "stopped", stoppedBy: "agent", reply: null, error: null, at: ENDED_AT })).toBeNull();
  expect(s.tasks.get(task.id)).toEqual(ended!);

  const archived = s.start("thr_a");
  expect(s.tasks.finish(archived.id, { status: "stopped", stoppedBy: "archive", reply: null, error: null, at: ENDED_AT }))
    .toMatchObject({ status: "stopped", stoppedBy: "archive", startedAt: null, finishedAt: ENDED_AT });
  const failed = s.start("thr_a");
  expect(s.tasks.finish(failed.id, { status: "failed", reply: null, error: "its replies kept reaching the output token limit", at: ENDED_AT }))
    .toMatchObject({ status: "failed", stoppedBy: null, error: "its replies kept reaching the output token limit" });
  expect(s.tasks.finish("task_missing", { status: "finished", reply: null, error: null, at: ENDED_AT })).toBeNull();
});

test("the open tasks are the queued and running ones of every conversation, oldest first", () => {
  const s = setup();
  const a1 = s.start("thr_a");
  const b1 = s.start("thr_b");
  const a2 = s.start("thr_a");
  s.tasks.markRunning(b1.id, "2026-01-01T00:00:00.000Z");
  s.tasks.finish(a1.id, { status: "interrupted", reply: null, error: null, at: ENDED_AT });
  expect(s.tasks.listOpen().map((t) => [t.id, t.status])).toEqual([[b1.id, "running"], [a2.id, "queued"]]);
});

test("the children's threads of the given conversations, and none for none", () => {
  const s = setup();
  const a1 = s.start("thr_a");
  const b1 = s.start("thr_b");
  s.start("thr_c");
  const a2 = s.start("thr_a");
  expect(s.tasks.childThreadIdsOf(["thr_a", "thr_b"])).toEqual([a1.childThreadId!, b1.childThreadId!, a2.childThreadId!]);
  expect(s.tasks.childThreadIdsOf([])).toEqual([]);
  expect(s.tasks.childThreadIdsOf(["thr_none"])).toEqual([]);
});

// The link to the conversation that started a task lives on the task row.
test("on a new database the task row keeps its link to the conversation that started it, and threads carry none", () => {
  const s = setup();
  const columns = (db: MandateStore["db"], table: string) =>
    (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const expected = ["id", "kind", "parent_thread_id", "child_thread_id", "type", "title", "task", "status",
    "stopped_by", "reply", "error", "created_at", "started_at", "finished_at", "seq", "exit_code", "output_path", "pid", "output_lines"];
  expect(columns(s.store.db, "background_tasks")).toEqual(expected);
  expect(columns(s.store.db, "agent_threads")).not.toContain("parent_thread_id");
  // The next start converges on the same table.
  const again = new MandateStore(s.dir);
  try {
    expect(columns(again.db, "background_tasks")).toEqual(expected);
  } finally {
    again.db.close();
  }
});

// The routes, the change event and the limits are pinned where they are
// used (the tasks API, the client store, the subagent service); what only
// this test pins: the paths encode their ids and the cursor, a since of 0 is
// still asked for, and a page holds fifty.
test("the task paths encode their ids and the cursor, a since of 0 is asked for, and done tasks come fifty a page", () => {
  expect(API_PATHS.agentThreadTasks("thr 1")).toBe("/api/agents/threads/thr%201/tasks");
  expect(API_PATHS.agentTaskStop("task/1")).toBe("/api/agents/tasks/task%2F1/stop");
  expect(API_PATHS.agentTask("task/1")).toBe("/api/agents/tasks/task%2F1");
  expect(API_PATHS.agentThreadTasks("thr 1", { before: "2026-01-01T00:03:00.000Z|task_2" })).toBe("/api/agents/threads/thr%201/tasks?before=2026-01-01T00%3A03%3A00.000Z%7Ctask_2");
  expect(API_PATHS.agentThreadTasks("thr 1", { since: 0 })).toBe("/api/agents/threads/thr%201/tasks?since=0");
  expect(BACKGROUND_TASKS_PAGE).toBe(50);
});

// A background command is a task with no child thread: it runs from the
// start, ends with its exit code, and the subagents' queue never sees it.
test("a command task is created running, with no child thread; it ends with its exit code; the queue and the open list of subagents never see it", () => {
  const s = setup();
  const sub = s.start("thr_a");
  const cmd = s.tasks.createCommand({ parentThreadId: "thr_a", title: "Run the e2e suite", command: "make e2e", outputPath: "/tmp/x/task.log", pid: 4242, startedAt: ENDED_AT });
  expect(cmd).toMatchObject({ kind: "command", status: "running", childThreadId: null, command: "make e2e", outputPath: "/tmp/x/task.log", exitCode: null, startedAt: ENDED_AT });
  expect(s.tasks.pidOf(cmd.id)).toBe(4242);
  expect(s.tasks.listOpen("subagent").map((t) => t.id)).toEqual([sub.id]);
  expect(s.tasks.listOpen("command").map((t) => t.id)).toEqual([cmd.id]);
  expect(s.tasks.listOpen().map((t) => t.id).sort()).toEqual([sub.id, cmd.id].sort());
  expect(s.tasks.countRunning("thr_a", "subagent")).toBe(0);
  expect(s.tasks.countRunning("thr_a", "command")).toBe(1);
  expect(s.tasks.oldestQueued("thr_a")?.id).toBe(sub.id);
  expect(s.tasks.runningOutputPaths()).toEqual(["/tmp/x/task.log"]);
  expect(s.tasks.childThreadIdsOf(["thr_a"])).toEqual([sub.childThreadId!]);
  const ended = s.tasks.finishCommand(cmd.id, { status: "failed", exitCode: 1, reply: "3 issues found", error: "exit 1", at: ENDED_AT })!;
  expect([ended.status, ended.exitCode, ended.seq > cmd.seq]).toEqual(["failed", 1, true]);
  expect(s.tasks.finishCommand(cmd.id, { status: "stopped", stoppedBy: "user", exitCode: null, reply: null, error: null, at: ENDED_AT })).toBeNull();
  expect(s.tasks.runningOutputPaths()).toEqual([]);
  // Two commands: no child thread, no unique clash.
  expect(() => s.tasks.createCommand({ parentThreadId: "thr_a", title: "b", command: "b", outputPath: "/tmp/b", pid: null, startedAt: ENDED_AT })).not.toThrow();
  // A subagent, queued or running, is not finished as a command.
  expect(s.tasks.finishCommand(sub.id, { status: "finished", exitCode: 0, reply: null, error: null, at: ENDED_AT })).toBeNull();
  s.tasks.markRunning(sub.id, ENDED_AT);
  expect(s.tasks.finishCommand(sub.id, { status: "finished", exitCode: 0, reply: null, error: null, at: ENDED_AT })).toBeNull();
  expect(s.tasks.get(sub.id)!.status).toBe("running");
  // Nor a command as a subagent: it stays running.
  const live = s.tasks.createCommand({ parentThreadId: "thr_a", title: "c", command: "c", outputPath: "/tmp/c", pid: null, startedAt: ENDED_AT });
  expect(s.tasks.finish(live.id, { status: "stopped", stoppedBy: "archive", reply: null, error: null, at: ENDED_AT })).toBeNull();
  expect(s.tasks.get(live.id)!.status).toBe("running");
});

// Read every hour by the tool-output retention: it must cost what is open,
// not the whole history of ended tasks.
test("the running commands' output paths are read through the open-task index", () => {
  const env = freshStoresEnv("md-bg-running-paths-");
  onCleanup(env.cleanup);
  const plan = (env.store.db.prepare(`explain query plan ${RUNNING_OUTPUT_PATHS_SQL}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" ");
  expect(plan).toContain("idx_background_tasks_open");
});
