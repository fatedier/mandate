import { expect, test } from "bun:test";
import { buildPersonalActionTools, buildPersonalArchiveTools } from "../src/server/modules/personal/personal-tools.js";
import type { ThreadArchiveInput, ThreadArchiveResult } from "../src/server/modules/agent/thread-archive.js";
import { VOICE_TOOL_WAKE_ID, type HandoffService } from "../src/server/modules/personal/handoff-service.js";
import { MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../src/server/modules/agent/wake-message-adapter.js";
import { stub, toolContext } from "./helpers/typed.js";

function tools(sent: Record<string, unknown> = { id: "hof_t" }) {
  const calls: Array<[string, unknown]> = [];
  const handoffs = stub<HandoffService>({
    sendToWorker: (input: unknown) => { calls.push(["sendToWorker", input]); return { id: "hof_f" } as never; },
    sendToThread: (input: unknown) => { calls.push(["sendToThread", input]); return sent as never; },
    asksNow: (threadId: string | undefined) => threadId === "thr_1",
    awaitStop: (input: { threadId?: string }) => {
      calls.push(["awaitStop", input]);
      if (input.threadId === "thr_stopped") return { stopped: "stopped" as const };
      if (input.threadId === "thr_gone") throw new Error("thread not found: thr_gone");
      return { handoff: { id: "hof_w" } as never };
    }
  });
  const byName = new Map(buildPersonalActionTools({ handoffs }).map((tool) => [tool.name, tool]));
  return { calls, byName };
}
const ctx = (wakeId = "w1") => toolContext({ threadId: "g1", wakeId });

test("the agent has three ways to act: message a worker, send to a thread, wait for a stop", () => {
  expect([...tools().byName.keys()]).toEqual(["message_worker", "send_to_thread", "await_stop"]);
});

test("send_to_thread sends at once, to a thread or a new one, spoken when voice called it", async () => {
  const t = tools();
  expect(await t.byName.get("send_to_thread")!.handler({ threadId: "thr_1", text: "Fix the timeout" }, ctx())).toEqual({ handoff: { id: "hof_t" } });
  await t.byName.get("send_to_thread")!.handler({ newThreadTitle: "Search timeout", text: "Fix the timeout" }, ctx(VOICE_TOOL_WAKE_ID));
  await t.byName.get("send_to_thread")!.handler({ threadId: "thr_1", text: "\"Push it.\"", answers: "Push the branch?" }, ctx());
  expect(t.calls).toStrictEqual([
    ["sendToThread", { personalThreadId: "g1", threadId: "thr_1", newThreadTitle: undefined, text: "Fix the timeout", spoken: false, answers: undefined }],
    ["sendToThread", { personalThreadId: "g1", threadId: undefined, newThreadTitle: "Search timeout", text: "Fix the timeout", spoken: true, answers: undefined }],
    // The question it answers, as the agent named it.
    ["sendToThread", { personalThreadId: "g1", threadId: "thr_1", newThreadTitle: undefined, text: "\"Push it.\"", spoken: false, answers: "Push the branch?" }]
  ]);
});

// The agent's own question, answered by the user, is no question of the
// thread's: the message goes as written, and the agent hears why.
test("send_to_thread with an answer for a thread that asks nothing now sends the message as written, and says so", async () => {
  const t = tools();
  expect(await t.byName.get("send_to_thread")!.handler({ threadId: "thr_2", text: "\"Use the spring menu.\"", answers: "Which menu should the order form show?" }, ctx()))
    .toEqual({ handoff: { id: "hof_t" }, note: "Sent without `answers`: that thread has no open question to answer." });
  expect(await t.byName.get("send_to_thread")!.handler({ newThreadTitle: "Search timeout", text: "Yes.", answers: "Push the branch?" }, ctx()))
    .toEqual({ handoff: { id: "hof_t" }, note: "Sent without `answers`: that thread has no open question to answer." });
  expect(t.calls.map(([, input]) => (input as { answers?: string }).answers)).toStrictEqual([undefined, undefined]);
});

test("the note leads the result: a long message the handoff carries cannot push it past what the model is shown", async () => {
  const text = "x".repeat(20_000);
  const t = tools({ id: "hof_t", text });
  const result = await t.byName.get("send_to_thread")!.handler({ threadId: "thr_2", text, answers: "Which menu should the order form show?" }, ctx());
  expect(JSON.stringify(result).slice(0, MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS)).toContain("Sent without `answers`: that thread has no open question to answer.");
});

test("message_worker passes the agent's message to the worker named", async () => {
  const t = tools();
  expect(await t.byName.get("message_worker")!.handler({ workerId: "wkr_1", text: "Do not delete it yet" }, ctx())).toEqual({ handoff: { id: "hof_f" } });
  expect(t.calls).toStrictEqual([["sendToWorker", { personalThreadId: "g1", workerId: "wkr_1", text: "Do not delete it yet", spoken: false }]]);
});

test("await_stop says a wait is armed, or how the target has already stopped, or why it cannot", async () => {
  const t = tools();
  const call = (args: Record<string, unknown>) => t.byName.get("await_stop")!.handler(args, ctx());
  expect(await call({ threadId: "thr_1" })).toEqual({ waiting: true, handoff: { id: "hof_w" } });
  expect(await call({ threadId: "thr_stopped" })).toEqual({ waiting: false, stopped: "stopped", label: "stopped" });
  expect(await call({ threadId: "thr_gone" })).toEqual({ error: "thread not found: thr_gone" });
  expect(t.calls.at(0)).toEqual(["awaitStop", { personalThreadId: "g1", threadId: "thr_1", workerId: undefined }]);
});

// The user could not ask the agent to put a thread away: no agent could
// archive one. It can now, through the same archive the thread's own dialog
// uses, and only on the user's word.

const THREAD = { id: "thr_1", title: "project-1 cache expiry", named: true, createdAt: "", lastActivityAt: "", lastVisibleSeq: 0, seenSeq: 0, running: false, failed: false, stopReason: null, questions: [], archivedAt: "2026-09-13T00:00:00.000Z", duty: null, labels: [], projects: [] };

function archiveTool(answer: (input: ThreadArchiveInput) => ThreadArchiveResult) {
  const asked: ThreadArchiveInput[] = [];
  const [tool, ...others] = buildPersonalArchiveTools({ threadArchive: { archive: async (input) => { asked.push(input); return answer(input); } } });
  return { tool: tool!, others, asked, call: (args: Record<string, unknown>) => tool!.handler(args, ctx()) };
}

test("archive_thread is the agent's one way to archive, described word for word", () => {
  const { tool, others } = archiveTool(() => ({ ok: false, status: 404, error: "thread not found" }));
  expect([tool.name, others]).toEqual(["archive_thread", []]);
  expect(tool.description).toBe(
    "Archive a thread together with its workers, when the user asked for that thread to be archived. It refuses, changing nothing, while a worker has uncommitted files or work that is not in its base, and returns what it found for each worker: tell the user, and pass `confirmedByUser: true` only after they said to archive anyway. The thread moves to the Archived tab of the Threads page, where the user can still read it but nothing more can be sent; the workers' records, chats and plans are kept."
  );
});

test("archive_thread archives the thread with its workers and says which went, and what a cleanup could not do", async () => {
  const done = archiveTool(() => ({ ok: true, thread: THREAD, workers: [{ id: "wkr_1", name: "EvictHook" }, { id: "wkr_2", name: "Docs" }], cleanupFailures: [] }));
  expect(await done.call({ threadId: "thr_1" })).toEqual({ ok: true, threadId: "thr_1", archivedWorkers: ["EvictHook", "Docs"] });
  // Nothing of its own is decided here: each worker's cleanup is its own kind's.
  expect(done.asked).toStrictEqual([{ threadId: "thr_1", confirmed: [] }]);

  const failures = [{ kind: "branch" as const, branch: "evict-hook", error: "not fully merged" }];
  const partly = archiveTool(() => ({ ok: true, thread: THREAD, workers: [{ id: "wkr_1", name: "EvictHook" }], cleanupFailures: failures }));
  expect(await partly.call({ threadId: "thr_1" })).toEqual({ ok: true, threadId: "thr_1", archivedWorkers: ["EvictHook"], cleanupFailures: failures });
});

test("archive_thread passes on a refusal with what was found in each worker, and the user's word confirms those workers and no others", async () => {
  const found = [{ id: "wkr_2", name: "Docs", findings: ["3 uncommitted files in the worktree.", "2 commits are not in main."] }];
  const t = archiveTool((input) => input.confirmed?.includes("wkr_2")
    ? { ok: true, thread: THREAD, workers: [{ id: "wkr_2", name: "Docs" }], cleanupFailures: [] }
    : { ok: false, status: 409, error: "Archiving would lose work in: Docs.", workers: found, archived: [], cleanupFailures: [] });
  // Said before anything was shown, the user's word confirms nothing.
  expect(await t.call({ threadId: "thr_1", confirmedByUser: true })).toEqual({ error: "Archiving would lose work in: Docs.", workers: found });
  // Anything but `true` is not the user's word.
  expect(await t.call({ threadId: "thr_1", confirmedByUser: false })).toEqual({ error: "Archiving would lose work in: Docs.", workers: found });
  // Said after the refusal, it confirms the workers that refusal named.
  expect(await t.call({ threadId: "thr_1", confirmedByUser: true })).toEqual({ ok: true, threadId: "thr_1", archivedWorkers: ["Docs"] });
  expect(t.asked.map((input) => input.confirmed)).toStrictEqual([[], [], ["wkr_2"]]);
  // Once it has gone through, nothing is left confirmed for a later archive of that id.
  await t.call({ threadId: "thr_1", confirmedByUser: true });
  expect(t.asked.at(-1)!.confirmed).toEqual([]);
});

test("archive_thread keeps what was shown for each thread apart, and adds what a later refusal names", async () => {
  const answers: Record<string, string[]> = { thr_1: ["wkr_2"], thr_2: ["wkr_9"] };
  const t = archiveTool((input) => ({
    ok: false, status: 409, error: "Archiving would lose work.",
    workers: answers[input.threadId]!.filter((id) => !input.confirmed?.includes(id)).map((id) => ({ id, name: id, findings: ["1 uncommitted file in the worktree."] })),
    archived: [], cleanupFailures: []
  }));
  await t.call({ threadId: "thr_1" });
  await t.call({ threadId: "thr_2" });
  // A worker that appeared since the first refusal: named now, confirmed next time with the first.
  answers.thr_1 = ["wkr_2", "wkr_3"];
  await t.call({ threadId: "thr_1", confirmedByUser: true });
  await t.call({ threadId: "thr_1", confirmedByUser: true });
  await t.call({ threadId: "thr_2", confirmedByUser: true });
  expect(t.asked.map((input) => [input.threadId, input.confirmed])).toStrictEqual([
    ["thr_1", []], ["thr_2", []], ["thr_1", ["wkr_2"]], ["thr_1", ["wkr_2", "wkr_3"]], ["thr_2", ["wkr_9"]]
  ]);
});

test("archive_thread says which workers had gone when a later one stopped it, and when there is no such thread", async () => {
  const left = [{ kind: "branch" as const, branch: "evict-hook", error: "not fully merged" }];
  const late = archiveTool(() => ({
    ok: false, status: 409, error: "Archiving would lose work in: Docs.",
    workers: [{ id: "wkr_2", name: "Docs", findings: ["1 uncommitted file in the worktree."] }],
    archived: [{ id: "wkr_1", name: "EvictHook" }],
    cleanupFailures: left
  }));
  expect(await late.call({ threadId: "thr_1" })).toEqual({
    error: "Archiving would lose work in: Docs.",
    workers: [{ id: "wkr_2", name: "Docs", findings: ["1 uncommitted file in the worktree."] }],
    archivedWorkers: ["EvictHook"],
    // What the worker that went could not clean up, though the archive stopped.
    cleanupFailures: left
  });
  const gone = archiveTool(() => ({ ok: false, status: 404, error: "thread not found" }));
  expect(await gone.call({ threadId: "thr_gone" })).toEqual({ error: "thread not found" });
});

test("a blank threadId, title or workerId counts as not given: the call goes where its real value says", async () => {
  const t = tools();
  const send = t.byName.get("send_to_thread")!;
  const wait = t.byName.get("await_stop")!;
  // As a model fills the field it does not mean.
  for (const args of [{ threadId: "thr_1", newThreadTitle: " ", text: "Fix it" }, { threadId: "thr_1", newThreadTitle: "", text: "Fix it" }]) {
    expect(send.parameters.safeParse(args).success).toBe(true);
    await send.handler(send.parameters.parse(args), ctx());
  }
  await send.handler(send.parameters.parse({ threadId: "", newThreadTitle: "Search timeout", text: "Fix it" }), ctx());
  expect(wait.parameters.safeParse({ threadId: "thr_1", workerId: "" }).success).toBe(true);
  expect(wait.parameters.safeParse({ threadId: "thr_1", workerId: null }).success).toBe(true);
  expect(send.parameters.safeParse({ threadId: "thr_1", newThreadTitle: null, text: "Fix it" }).success).toBe(true);
  await wait.handler(wait.parameters.parse({ threadId: "thr_1", workerId: "" }), ctx());
  expect(t.calls.map(([name, input]) => [name, (input as { threadId?: string }).threadId, (input as { newThreadTitle?: string }).newThreadTitle, (input as { workerId?: string }).workerId])).toStrictEqual([
    ["sendToThread", "thr_1", undefined, undefined],
    ["sendToThread", "thr_1", undefined, undefined],
    ["sendToThread", undefined, "Search timeout", undefined],
    ["awaitStop", "thr_1", undefined, undefined]
  ]);
});

// A task named with the send links the thread it went to, a new one included.
test("send_to_thread with a task links the thread, a new one included", async () => {
  const linked: Array<[string, string, unknown]> = [];
  const taskBoard = {
    detail: (id: string) => (id === "tsk_live" ? { id, deletedAt: null } : id === "tsk_gone" ? { id, deletedAt: "2026-11-01T00:00:00.000Z" } : null),
    link: (taskId: string, threadId: string, opts: unknown) => { linked.push([taskId, threadId, opts]); return true; }
  };
  const sentWith: Array<{ taskId?: string }> = [];
  const handoffs = stub<HandoffService>({
    sendToThread: (input: { threadId?: string; newThreadTitle?: string; taskId?: string }) => { sentWith.push(input); return { id: "hof_t", threadId: input.threadId ?? "thr_new", newThreadTitle: input.newThreadTitle ?? null } as never; },
    asksNow: () => false
  });
  const send = buildPersonalActionTools({ handoffs, taskBoard: taskBoard as never }).find((t) => t.name === "send_to_thread")!;
  await send.handler({ threadId: "thr_1", text: "Count the loaves sold", taskId: "tsk_live" }, ctx());
  await send.handler({ newThreadTitle: "Research loaf pricing", text: "Compare four bakeries", taskId: "tsk_live" }, ctx());
  await send.handler({ threadId: "thr_1", text: "No task here", taskId: "" }, ctx());
  expect(linked).toStrictEqual([["tsk_live", "thr_1", { newThread: false }], ["tsk_live", "thr_new", { newThread: true }]]);
  // The brief goes with its task, for the thread's page to show.
  expect(sentWith.map((input) => input.taskId)).toEqual(["tsk_live", "tsk_live", undefined]);
});

test("send_to_thread with an unknown task sends nothing", async () => {
  const t = tools();
  const taskBoard = { detail: (id: string) => (id === "tsk_gone" ? { id, deletedAt: "2026-11-01T00:00:00.000Z" } : null), link: () => true };
  const send = buildPersonalActionTools({ handoffs: stub<HandoffService>({ sendToThread: () => { throw new Error("must not send"); }, asksNow: () => false }), taskBoard: taskBoard as never }).find((x) => x.name === "send_to_thread")!;
  expect(await send.handler({ threadId: "thr_1", text: "x", taskId: "tsk_none" }, ctx())).toEqual({ error: "No such task: tsk_none." });
  expect(await send.handler({ threadId: "thr_1", text: "x", taskId: "tsk_gone" }, ctx())).toEqual({ error: "No such task: tsk_gone." });
  expect(t.calls).toEqual([]);
});
