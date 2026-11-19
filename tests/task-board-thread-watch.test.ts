import { expect, test } from "bun:test";
import { watchTaskThreads } from "../src/server/modules/task-board/thread-watch.js";

function fakeSse() {
  let sink: ((e: { event: string; data: unknown }) => void) | null = null;
  return {
    sse: { addSink: (s: typeof sink) => { sink = s; return () => { sink = null; }; } },
    send: (event: string, data: unknown) => sink?.({ event, data })
  };
}
const flush = () => new Promise((r) => queueMicrotask(() => r(null)));
const noMoves = { onOwnerChange: () => () => {} };

// When the status snapshot moves a thread's dot, that thread's tasks go out
// again, after the snapshot.
test("a thread whose dot changed in the status snapshot sends its tasks again, after the snapshot", async () => {
  const f = fakeSse();
  const changed: string[] = [];
  const stop = watchTaskThreads(f.sse as never, { threadChanged: (id) => { changed.push(id); } }, noMoves);
  f.send("threadStatus", { threads: [{ threadId: "thr_a", state: "working" }, { threadId: "thr_b", state: "idle" }], waiting: [] });
  await flush();
  expect(changed.sort()).toEqual(["thr_a", "thr_b"]);
  changed.length = 0;
  f.send("threadStatus", { threads: [{ threadId: "thr_a", state: "needs_you" }, { threadId: "thr_b", state: "idle" }], waiting: [] });
  await flush();
  expect(changed).toEqual(["thr_a"]);
  changed.length = 0;
  f.send("threadStatus", { threads: [{ threadId: "thr_a", state: "needs_you" }], waiting: [] });
  await flush();
  expect(changed).toEqual(["thr_b"]);
  stop();
});

test("a thread's turn end sends its tasks again", async () => {
  const f = fakeSse();
  const changed: string[] = [];
  watchTaskThreads(f.sse as never, { threadChanged: (id) => { changed.push(id); } }, noMoves);
  f.send("agentWakeFinished", { threadId: "thr_a", wakeId: "w", status: "finished" });
  f.send("workerCreated", { worker: {} });
  await flush();
  expect(changed).toEqual(["thr_a"]);
});

// The thread a worker left gets no turn end or dot change of its own, yet
// its tasks' automatic labels change.
test("a worker moving thread sends the tasks of the thread it left and of the one it joined", async () => {
  const f = fakeSse();
  const changed: string[] = [];
  let tell: ((m: { workerId: string; from: string | null; to: string }) => void) | null = null;
  const workers = { onOwnerChange: (l: NonNullable<typeof tell>) => { tell = l; return () => { tell = null; }; } };
  const stop = watchTaskThreads(f.sse as never, { threadChanged: (id) => { changed.push(id); } }, workers);
  tell!({ workerId: "wkr_a", from: "thr_old", to: "thr_new" });
  tell!({ workerId: "wkr_b", from: null, to: "thr_made" });
  await flush();
  expect(changed).toEqual(["thr_old", "thr_new", "thr_made"]);
  stop();
  expect(tell).toBeNull();
});

// Deleting an archived thread takes its workers, and so its tasks' automatic
// labels, and moves no dot.
test("a deleted thread sends its tasks again", async () => {
  const f = fakeSse();
  const changed: string[] = [];
  watchTaskThreads(f.sse as never, { threadChanged: (id) => { changed.push(id); } }, noMoves);
  f.send("managerThreadDeleted", { threadId: "thr_gone" });
  await flush();
  expect(changed).toEqual(["thr_gone"]);
});
