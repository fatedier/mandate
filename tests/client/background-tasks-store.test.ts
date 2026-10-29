import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { refetchBackgroundTasks, useBackgroundTasksStore } from "@/store/background-tasks";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { backgroundTask, resetBackgroundTasksStore, taskDetail } from "../helpers/subagent-client.js";

// A conversation's background tasks, read as its messages are: once, kept
// current by events, brought up to date after the stream was down by what
// changed after the last read. Each change of a task takes the next number
// of all tasks, so of two copies the one with the greater is the later: a
// read taken before an event, or Stop's answer arriving after the end's
// event, never puts a task back. Each test names its own thread: reads on
// their way are module state.

const state = () => useBackgroundTasksStore.getState();
const held = (threadId: string) => state().byThread.get(threadId)?.map((t) => `${t.id}:${t.status}`) ?? null;
const task = (id: string, parentThreadId: string, over: Partial<BackgroundTaskDto> = {}) =>
  backgroundTask({ id, parentThreadId, childThreadId: `thr_child_${id}`, title: `Job ${id}`, ...over });
/** A done task that ended at 09:MM. */
const ended = (id: string, threadId: string, minute: number, over: Partial<BackgroundTaskDto> = {}) =>
  task(id, threadId, { status: "finished", finishedAt: `2026-10-18T09:${String(minute).padStart(2, "0")}:00.000Z`, ...over });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(async () => {
  // A read another file left failed is read again by a reconnect: read them
  // now, so a test here sees its own conversations alone.
  const drain = mockFetch(() => jsonResponse({ tasks: [] }));
  await refetchBackgroundTasks();
  drain.length = 0;
  resetBackgroundTasksStore();
});
afterEach(resetBackgroundTasksStore);

test("a conversation's tasks are read once, by one request however many ask; again only when asked to", async () => {
  const calls = mockFetch(() => jsonResponse({ tasks: [task("t2", "thr_a"), task("t1", "thr_a", { status: "finished" })] }));
  await Promise.all([state().load("thr_a"), state().load("thr_a")]);
  expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual(["GET /api/agents/threads/thr_a/tasks"]);
  expect(held("thr_a")).toEqual(["t2:running", "t1:finished"]);
  await state().load("thr_a");
  expect(calls).toHaveLength(1);
  await state().load("thr_a", { again: true });
  expect(calls).toHaveLength(2);
});

test("an event heard while the first read is on its way is kept: the read was taken before it", async () => {
  const answer = deferred();
  mockFetch(() => answer.promise);
  const loading = state().load("thr_b");
  // Ended, and a new one queued, after the read was taken: the read has the
  // first still running and the second not at all.
  state().apply(task("t1", "thr_b", { status: "finished", finishedAt: "2026-10-18T09:03:00.000Z" }));
  state().apply(task("t3", "thr_b", { status: "queued", startedAt: null }));
  expect(held("thr_b")).toBeNull();
  answer.resolve(jsonResponse({ tasks: [task("t1", "thr_b")] }));
  await loading;
  expect(held("thr_b")).toEqual(["t3:queued", "t1:finished"]);
});

test("a read keeps a task's later copy: an event heard while the first read was on its way that the read already passes changes nothing", async () => {
  const answer = deferred();
  mockFetch(() => answer.promise);
  const loading = state().load("thr_b2");
  state().apply(task("t1", "thr_b2", { seq: 2 }));
  answer.resolve(jsonResponse({ tasks: [ended("t1", "thr_b2", 3, { seq: 6 })], olderDone: null, seq: 6 }));
  await loading;
  expect(held("thr_b2")).toEqual(["t1:finished"]);
});

test("a task never goes back: an older copy, or Stop's answer after the end's event, changes nothing; a later one replaces it", () => {
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_c", [task("t1", "thr_c")]]]) });
  const before = state().byThread;
  state().apply(task("t1", "thr_c", { status: "queued", startedAt: null }));
  expect(state().byThread).toBe(before);
  state().apply(task("t1", "thr_c", { status: "stopped", stoppedBy: "user" }));
  expect(held("thr_c")).toEqual(["t1:stopped"]);
  state().apply(task("t1", "thr_c", { status: "running" }));
  expect(held("thr_c")).toEqual(["t1:stopped"]);
  // A new one is the newest: first.
  state().apply(task("t2", "thr_c", { status: "queued", startedAt: null }));
  expect(held("thr_c")).toEqual(["t2:queued", "t1:stopped"]);
});

test("an event for a conversation never read here is dropped: its read, when one comes, has it", () => {
  state().apply(task("t1", "thr_d"));
  expect(state().byThread.has("thr_d")).toBe(false);
});

test("a read that does not answer with tasks fails and leaves the conversation unread: the next ask reads again", async () => {
  const calls = mockFetch((_, index) => (index === 0 ? jsonResponse({ thread: { id: "thr_e" }, messages: [] }) : jsonResponse({ tasks: [] })));
  await expect(state().load("thr_e")).rejects.toThrow("The server answered without the conversation's tasks.");
  expect(state().byThread.has("thr_e")).toBe(false);
  await state().load("thr_e");
  expect([calls.length, held("thr_e")]).toEqual([2, []]);
});

test("Stop posts for the task and takes the answer in; a refusal comes back in the server's words and changes nothing", async () => {
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_f", [task("t1", "thr_f"), task("t2", "thr_f", { status: "finished" })]]]) });
  const calls = mockFetch(({ url }) => (url.endsWith("/t1/stop")
    ? jsonResponse({ task: task("t1", "thr_f", { status: "stopped", stoppedBy: "user" }) })
    : jsonResponse({ error: "No running task t2 of this conversation." }, 409)));
  expect(await state().stop("t1")).toBeNull();
  expect(held("thr_f")).toEqual(["t1:stopped", "t2:finished"]);
  expect(await state().stop("t2")).toBe("No running task t2 of this conversation.");
  expect(held("thr_f")).toEqual(["t1:stopped", "t2:finished"]);
  expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual(["POST /api/agents/tasks/t1/stop", "POST /api/agents/tasks/t2/stop"]);
});

test("backgroundTaskChanged lands in the store", async () => {
  const { attachSnapshotSseListeners } = await import("@/lib/snapshot-sse-listeners");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_g", []]]) });
  source.dispatchEvent(new MessageEvent("backgroundTaskChanged", { data: JSON.stringify({ task: task("t1", "thr_g") }) }));
  expect(held("thr_g")).toEqual(["t1:running"]);
});

test("after the stream was down every conversation read here reads what changed after its last read, and takes it in", async () => {
  useBackgroundTasksStore.setState({
    byThread: new Map([["thr_h", [task("t1", "thr_h", { seq: 4 }), ended("t0", "thr_h", 1, { seq: 3 })]], ["thr_i", []]]),
    pages: new Map([["thr_h", { olderDone: "c0", loadingOlder: false, seq: 4 }], ["thr_i", { olderDone: null, loadingOlder: false, seq: 2 }]])
  });
  const calls = mockFetch(({ url }) => jsonResponse(url.includes("thr_h")
    ? { tasks: [ended("t1", "thr_h", 30, { seq: 9 }), task("t7", "thr_h", { status: "queued", startedAt: null, seq: 10 })], seq: 11 }
    : { tasks: [], seq: 11 }));
  await refetchBackgroundTasks();
  expect(calls.map((c) => c.url).sort()).toStrictEqual(["/api/agents/threads/thr_h/tasks?since=4", "/api/agents/threads/thr_i/tasks?since=2"]);
  // Nothing held is dropped; where its pages go on is where it was.
  expect([held("thr_h"), state().pages.get("thr_h"), state().pages.get("thr_i")!.seq]).toEqual([
    ["t7:queued", "t1:finished", "t0:finished"], { olderDone: "c0", loadingOlder: false, seq: 11 }, 11
  ]);
});

test("a first read that failed is read again after the stream was down, and the events after it land", async () => {
  const calls = mockFetch((_, index) => (index === 0 ? jsonResponse({ error: "Server restarting." }, 503) : jsonResponse({ tasks: [task("t1", "thr_j")], olderDone: null, seq: 2 })));
  await expect(state().load("thr_j")).rejects.toThrow("Server restarting.");
  expect(state().byThread.has("thr_j")).toBe(false);
  await refetchBackgroundTasks();
  expect(calls.map((c) => c.url)).toStrictEqual(["/api/agents/threads/thr_j/tasks", "/api/agents/threads/thr_j/tasks"]);
  expect(held("thr_j")).toEqual(["t1:running"]);
  state().apply(task("t1", "thr_j", { status: "finished" }));
  expect(held("thr_j")).toEqual(["t1:finished"]);
});

test("a reconnect while a read of what changed is on its way reads again once that one has answered: it may predate what the outage hid", async () => {
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_k", [task("t1", "thr_k", { seq: 4 })]]]), pages: new Map([["thr_k", { olderDone: null, loadingOlder: false, seq: 4 }]]) });
  const first = deferred();
  const calls = mockFetch((_, index) => (index === 0 ? first.promise : jsonResponse({ tasks: [ended("t1", "thr_k", 5, { seq: 9 })], seq: 9 })));
  const earlier = state().load("thr_k", { again: true });
  const refetched = refetchBackgroundTasks();
  // Taken before the end the outage hid: nothing had changed yet.
  first.resolve(jsonResponse({ tasks: [], seq: 4 }));
  await Promise.all([earlier, refetched]);
  expect(calls.map((c) => c.url)).toStrictEqual(["/api/agents/threads/thr_k/tasks?since=4", "/api/agents/threads/thr_k/tasks?since=4"]);
  expect(held("thr_k")).toEqual(["t1:finished"]);
});

test("a reconnect during a conversation's first read reads what changed after it once it has answered", async () => {
  const first = deferred();
  const calls = mockFetch((_, index) => (index === 0 ? first.promise : jsonResponse({ tasks: [ended("t1", "thr_l", 5, { seq: 9 })], seq: 9 })));
  const loading = state().load("thr_l");
  const refetched = refetchBackgroundTasks();
  // Taken before the end the outage hid.
  first.resolve(jsonResponse({ tasks: [task("t1", "thr_l", { seq: 5 })], olderDone: null, seq: 5 }));
  await Promise.all([loading, refetched]);
  expect(calls.map((c) => c.url)).toStrictEqual(["/api/agents/threads/thr_l/tasks", "/api/agents/threads/thr_l/tasks?since=5"]);
  expect(held("thr_l")).toEqual(["t1:finished"]);
});

test("a Stop asked again while one is on its way sends nothing more, answers as that one does, and says so while it waits", async () => {
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_m2", [task("t1", "thr_m2")]]]) });
  const answer = deferred();
  const calls = mockFetch(() => answer.promise);
  const first = state().stop("t1");
  const again = state().stop("t1");
  expect(state().stopping.has("t1")).toBe(true);
  answer.resolve(jsonResponse({ task: task("t1", "thr_m2", { status: "stopped", stoppedBy: "user" }) }));
  expect(await Promise.all([first, again])).toEqual([null, null]);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  expect(state().stopping.has("t1")).toBe(false);
  expect(held("thr_m2")).toEqual(["t1:stopped"]);
});

test("a read keeps where its older done ones start and the number it reflects", async () => {
  mockFetch(() => jsonResponse({ tasks: [task("t2", "thr_n"), ended("t1", "thr_n", 1)], olderDone: "2026-10-18T09:01:00.000Z|t1", seq: 7 }));
  await state().load("thr_n");
  expect(state().pages.get("thr_n")).toEqual({ olderDone: "2026-10-18T09:01:00.000Z|t1", loadingOlder: false, seq: 7 });
});

test("older done ones come a page at a time after those held; a failed page says why; a page leaves the number the first read reflects", async () => {
  const calls = mockFetch(({ url }, index) => {
    if (!url.includes("before=")) return jsonResponse({ tasks: [ended("t3", "thr_o", 3)], olderDone: "c3", seq: 20 });
    if (index === 1) return jsonResponse({ error: "Server restarting." }, 503);
    return jsonResponse({ tasks: [ended("t2", "thr_o", 2), ended("t1", "thr_o", 1, { status: "stopped" })], olderDone: null, seq: 30 });
  });
  await state().load("thr_o");
  expect(await state().loadOlder("thr_o")).toBe("Server restarting.");
  expect([held("thr_o"), state().pages.get("thr_o")]).toEqual([["t3:finished"], { olderDone: "c3", loadingOlder: false, seq: 20 }]);
  expect(await state().loadOlder("thr_o")).toBeNull();
  // Its number says nothing of the newer tasks: what changed after the first read is still read from 20.
  expect([held("thr_o"), state().pages.get("thr_o")]).toEqual([["t3:finished", "t2:finished", "t1:stopped"], { olderDone: null, loadingOlder: false, seq: 20 }]);
  expect(calls.map((c) => c.url)).toStrictEqual([
    "/api/agents/threads/thr_o/tasks",
    "/api/agents/threads/thr_o/tasks?before=c3",
    "/api/agents/threads/thr_o/tasks?before=c3"
  ]);
});

test("one page at a time: Show older asked again while a page is on its way asks for nothing more", async () => {
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_o2", [ended("t3", "thr_o2", 3)]]]), pages: new Map([["thr_o2", { olderDone: "c3", loadingOlder: false, seq: 5 }]]) });
  const page = deferred();
  const calls = mockFetch(() => page.promise);
  const first = state().loadOlder("thr_o2");
  expect([await state().loadOlder("thr_o2"), state().pages.get("thr_o2")!.loadingOlder]).toEqual([null, true]);
  page.resolve(jsonResponse({ tasks: [ended("t2", "thr_o2", 2)], olderDone: null, seq: 5 }));
  expect(await first).toBeNull();
  expect([calls.length, held("thr_o2")]).toEqual([1, ["t3:finished", "t2:finished"]]);
});

test("a task's detail is read by one request however many ask; one older than its conversation's pages is kept on its own", async () => {
  useBackgroundTasksStore.setState({
    byThread: new Map([["thr_p", [task("t2", "thr_p"), ended("t3", "thr_p", 30)]]]),
    pages: new Map([["thr_p", { olderDone: "c3", loadingOlder: false, seq: 40 }]])
  });
  const old = ended("t1", "thr_p", 10);
  const calls = mockFetch(({ url }) => jsonResponse(url.endsWith("/t1")
    ? taskDetail(old, { brief: "Read the logs.", reply: "Nothing failed.", stepCount: 4 })
    : taskDetail(task("t2", "thr_p"), { brief: "Find the call sites." })));
  await Promise.all([state().loadDetail("t1"), state().loadDetail("t1"), state().loadDetail("t2")]);
  expect(calls.map((c) => c.url)).toStrictEqual(["/api/agents/tasks/t1", "/api/agents/tasks/t2"]);
  expect(state().details.get("t1")).toEqual({ brief: "Read the logs.", reply: "Nothing failed.", stepCount: 4, status: "finished" });
  expect([...state().loose.keys()]).toEqual(["t1"]);
  // The list is not where it goes: it is older than the pages read.
  expect(held("thr_p")).toEqual(["t2:running", "t3:finished"]);
});

test("a detail read before its task moved on is dropped once it has: what the task says now is read again", async () => {
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_q", [task("t1", "thr_q")]]]) });
  mockFetch(() => jsonResponse(taskDetail(task("t1", "thr_q"))));
  await state().loadDetail("t1");
  expect(state().details.get("t1")?.status).toBe("running");
  state().apply(task("t1", "thr_q", { status: "running" }));
  expect(state().details.has("t1")).toBe(true);
  state().apply(task("t1", "thr_q", { status: "finished" }));
  expect(state().details.has("t1")).toBe(false);
});

test("a detail read taken before its task ended but answered after the end was heard is read again: its reply comes", async () => {
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_r", [task("t1", "thr_r")]]]) });
  const first = deferred();
  const calls = mockFetch((_, index) => (index === 0 ? first.promise : jsonResponse(taskDetail(task("t1", "thr_r", { status: "finished" }), { reply: "Two call sites." }))));
  const reading = state().loadDetail("t1");
  state().apply(task("t1", "thr_r", { status: "finished" }));
  // A second ask, as the shown task moving on makes, joins the one on its way.
  const again = state().loadDetail("t1");
  first.resolve(jsonResponse(taskDetail(task("t1", "thr_r"))));
  await Promise.all([reading, again]);
  expect(calls).toHaveLength(2);
  expect(state().details.get("t1")).toEqual({ brief: "Summarise what changed in 0.72 from the material below.", reply: "Two call sites.", stepCount: 0, status: "finished" });
});

test("copies are taken in by their number, whatever order they come in: a detail or Stop answer from before an outage never puts a task back", async () => {
  // t1 and t2 ran when t1's detail and t2's Stop were asked for; then the
  // stream went down and both ended, with more than a page after them.
  for (const answersFirst of [true, false]) {
    const thread = answersFirst ? "thr_z1" : "thr_z2";
    resetBackgroundTasksStore();
    useBackgroundTasksStore.setState({ byThread: new Map([[thread, [task("t1", thread, { seq: 2 }), task("t2", thread, { seq: 3 })]]]), pages: new Map([[thread, { olderDone: null, loadingOlder: false, seq: 3 }]]) });
    const detail = deferred();
    const stopped = deferred();
    const changes = deferred();
    const calls = mockFetch(({ url, method }) => {
      if (method === "POST") return stopped.promise;
      if (url.endsWith("/tasks/t1")) return calls.filter((c) => c.url.endsWith("/tasks/t1")).length === 1 ? detail.promise : jsonResponse(taskDetail(ended("t1", thread, 1, { seq: 9 }), { reply: "Done." }));
      return changes.promise;
    });
    const reading = state().loadDetail("t1");
    const stopping = state().stop("t2");
    const refetching = refetchBackgroundTasks();
    const answer = () => {
      detail.resolve(jsonResponse(taskDetail(task("t1", thread, { seq: 2 }))));
      stopped.resolve(jsonResponse({ task: task("t2", thread, { seq: 3 }) }));
    };
    if (answersFirst) {
      answer();
      await Promise.all([reading, stopping]);
    }
    changes.resolve(jsonResponse({ tasks: [ended("t1", thread, 1, { seq: 9 }), ended("t2", thread, 2, { status: "stopped", stoppedBy: "user", seq: 10 })], seq: 60 }));
    await refetching;
    if (!answersFirst) {
      answer();
      await Promise.all([reading, stopping]);
    }
    if (answersFirst) {
      // Read before the end, the detail is behind the task now shown: its status moved on, so the task asks again (useTaskDetail).
      expect(state().details.get("t1")?.status).toBe("running");
      await state().loadDetail("t1");
    }
    expect([answersFirst, held(thread), state().details.get("t1")?.reply]).toEqual([answersFirst, ["t1:finished", "t2:stopped"], "Done."]);
  }
});

test("a task read by its id joins the list only where its pages reach; an old one's late event stays out of it", async () => {
  mockFetch(({ url }) => {
    if (url.endsWith("/tasks/t_old")) return jsonResponse(taskDetail(ended("t_old", "thr_v", 1, { status: "stopped", seq: 4 })));
    if (url.endsWith("/tasks/t_new")) return jsonResponse(taskDetail(task("t_new", "thr_v", { seq: 31 })));
    if (url.endsWith("/tasks/t_quick")) return jsonResponse(taskDetail(ended("t_quick", "thr_v", 40, { seq: 33 })));
    return jsonResponse({ tasks: [ended("t9", "thr_v", 30, { seq: 30 })], olderDone: "c9", seq: 30 });
  });
  await state().load("thr_v");
  await state().loadDetail("t_old");
  // Its events, overtaken by the reads, come late: neither puts it in the list, nor back.
  state().apply(task("t_old", "thr_v", { seq: 2 }));
  state().apply(ended("t_old", "thr_v", 1, { status: "stopped", seq: 4 }));
  expect([held("thr_v"), state().loose.get("t_old")?.status]).toEqual([["t9:finished"], "stopped"]);
  // A line names a task started after the list was read, before its event came: it is new, and listed.
  await state().loadDetail("t_new");
  expect([held("thr_v"), state().loose.has("t_new")]).toEqual([["t_new:running", "t9:finished"], false]);
  // One started and ended since the list was read ended after every done one it holds: new too.
  await state().loadDetail("t_quick");
  expect(held("thr_v")).toEqual(["t_quick:finished", "t_new:running", "t9:finished"]);
});

test("a detail read is repeated for its own task's moves only: other conversations' reads landing meanwhile do not repeat it", async () => {
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_q2", [task("t1", "thr_q2")]]]) });
  const detail = deferred();
  const calls = mockFetch(({ url }) => (url.endsWith("/tasks/t1") ? detail.promise : jsonResponse({ tasks: [], olderDone: null, seq: 0 })));
  const reading = state().loadDetail("t1");
  await state().load("thr_other_1");
  await state().load("thr_other_2");
  detail.resolve(jsonResponse(taskDetail(task("t1", "thr_q2"))));
  await reading;
  expect([calls.filter((c) => c.url.endsWith("/tasks/t1")).length, state().details.get("t1")?.status]).toEqual([1, "running"]);
});

test("a running command's last line is kept as it comes, and goes when the command ends", () => {
  const cmd = task("task_cmd", "thr_live", { kind: "command", childThreadId: null, command: "make e2e", outputPath: "/out/x.log" });
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_live", [cmd]]]) });
  state().applyOutput({ taskId: "task_cmd", parentThreadId: "thr_live", lastLine: "ok 12 - retries", bytes: 2048, lines: 40 });
  expect(state().liveLines.get("task_cmd")).toEqual({ lastLine: "ok 12 - retries", bytes: 2048, lines: 40 });
  state().apply({ ...cmd, status: "finished", exitCode: 0, seq: 9, finishedAt: "2026-10-18T09:05:00.000Z" });
  expect(state().liveLines.has("task_cmd")).toBe(false);
});

test("a live line is kept only for a command held here and running; a read that brings its end drops it", async () => {
  const cmd = task("task_cmd2", "thr_live2", { kind: "command", childThreadId: null, command: "make e2e", outputPath: "/out/x.log" });
  // A conversation never read here, and an ended command: nothing is kept.
  state().applyOutput({ taskId: "task_unknown", parentThreadId: "thr_never", lastLine: "x", bytes: 1, lines: 1 });
  useBackgroundTasksStore.setState({ byThread: new Map([["thr_live2", [{ ...cmd, id: "task_done2", status: "finished", exitCode: 0, seq: 9 }, cmd]]]), pages: new Map([["thr_live2", { olderDone: null, loadingOlder: false, seq: 5 }]]) });
  state().applyOutput({ taskId: "task_done2", parentThreadId: "thr_live2", lastLine: "late", bytes: 1, lines: 1 });
  expect([...state().liveLines.keys()]).toEqual([]);
  state().applyOutput({ taskId: "task_cmd2", parentThreadId: "thr_live2", lastLine: "ok", bytes: 2, lines: 1 });
  expect([...state().liveLines.keys()]).toEqual(["task_cmd2"]);
  // Its end was missed while the stream was down: the read after brings it, and the line goes.
  mockFetch(() => jsonResponse({ tasks: [{ ...cmd, status: "finished", exitCode: 0, seq: 12, finishedAt: "2026-10-18T09:06:00.000Z" }], seq: 12 }));
  await state().load("thr_live2", { again: true });
  expect(held("thr_live2")).toEqual(["task_done2:finished", "task_cmd2:finished"]);
  expect([...state().liveLines.keys()]).toEqual([]);
});
