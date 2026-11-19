import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { mountAgentsRoutes } from "../src/server/modules/agent/agents-api.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { ThreadLabelRefusal, ThreadLabels } from "../src/server/modules/agent/thread-labels.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { deleteJson, postJson } from "./helpers/test-app.js";

// A manager thread carries free labels the owner or the personal agent put
// on it: each name once whatever its case, the first spelling in use (on a
// thread or on a task) kept, and gone with the thread.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup(prefix: string, taskLabelSpelling?: (name: string) => string | null) {
  env = freshStoresEnv(prefix);
  const store = env.agentStore;
  const published: string[] = [];
  const labels = new ThreadLabels({
    agentStore: store,
    publish: (threadId) => { published.push(threadId); },
    ...(taskLabelSpelling ? { taskLabelSpelling } : {})
  });
  const thread = (title: string) => store.createManagerThread(title).id;
  return { env, store, labels, published, thread };
}

const refusal = (run: () => unknown): [string, number] | null => {
  try {
    run();
    return null;
  } catch (err) {
    if (!(err instanceof ThreadLabelRefusal)) throw err;
    return [err.message, err.status];
  }
};

test("labels are added by name, each once whatever its case, in the order added", () => {
  const t = setup("md-thl-add-");
  const id = t.thread("Billing research");
  t.labels.add(id, "  billing ", "owner");
  t.labels.add(id, "BILLING", "owner");
  expect(t.labels.add(id, "3.21", "agent")).toEqual([{ name: "billing", by: "owner" }, { name: "3.21", by: "agent" }]);
  expect(t.store.threadLabels(id)).toEqual([{ name: "billing", by: "owner" }, { name: "3.21", by: "agent" }]);
});

test("a name in use on another thread keeps its first spelling", () => {
  const t = setup("md-thl-spelling-");
  const a = t.thread("Billing research");
  const b = t.thread("Billing follow-up");
  t.labels.add(a, "Billing", "owner");
  expect(t.labels.add(b, "billing", "agent")).toEqual([{ name: "Billing", by: "agent" }]);
});

test("a name the task board has keeps the board's spelling, and the board keeps a thread's", () => {
  const t = setup("md-thl-board-", (name) => (name.toLowerCase() === "billing" ? "Billing" : null));
  const id = t.thread("Billing research");
  expect(t.labels.add(id, "billing", "owner")).toEqual([{ name: "Billing", by: "owner" }]);

  const board = new TaskBoardService({
    db: t.env.store.db, agentStore: t.store, sse: { emit: () => {} } as never, threadDots: () => new Map(),
    threadLabelSpelling: (name) => (name.toLowerCase() === "voice" ? "Voice" : null)
  });
  const task = board.create({ title: "Reply to the voice mail" }, "owner");
  expect(board.addLabel(task.id, "voice", "owner").labels).toEqual([{ name: "Voice", by: "owner" }]);
  // What the board answers when asked for a spelling: a label a task has.
  expect([board.labelSpelling("VOICE"), board.labelSpelling("nothing")]).toEqual(["Voice", null]);
});

test("the owner adding the agent's label makes it theirs; the agent adding the owner's changes nothing", () => {
  const t = setup("md-thl-by-");
  const id = t.thread("Billing research");
  t.labels.add(id, "billing", "agent");
  expect(t.labels.add(id, "Billing", "owner")).toEqual([{ name: "billing", by: "owner" }]);
  expect(t.labels.add(id, "billing", "agent")).toEqual([{ name: "billing", by: "owner" }]);
});

test("a label is one line of at most 40 characters", () => {
  const t = setup("md-thl-name-");
  const id = t.thread("Billing research");
  const refused: [string, number] = ["A label is a word or two: at most 40 characters.", 400];
  for (const name of ["x".repeat(41), "two\nlines", "   "]) expect(refusal(() => t.labels.add(id, name, "owner"))).toEqual(refused);
  expect(t.labels.add(id, "x".repeat(40), "owner")).toEqual([{ name: "x".repeat(40), by: "owner" }]);
});

// A label is taken off by its name in the address (DELETE …/labels/<name>),
// where "." and ".." are no name: fetch folds them away, escaped or not.
test("a label cannot be named \".\" or \"..\", which no address could take off again", () => {
  const t = setup("md-thl-dots-");
  const id = t.thread("Billing research");
  const refused: [string, number] = ["A label is a word or two: at most 40 characters.", 400];
  for (const name of [".", "..", " .. "]) expect(refusal(() => t.labels.add(id, name, "owner"))).toEqual(refused);
  expect(t.labels.add(id, "...", "owner")).toEqual([{ name: "...", by: "owner" }]);
  expect(new URL("http://x/api/threads/thr_1/labels/%2E%2E").pathname).toBe("/api/threads/thr_1/");
});

test("removing finds the label whatever its case; one the thread does not have is refused", () => {
  const t = setup("md-thl-remove-");
  const id = t.thread("Billing research");
  t.labels.add(id, "Billing", "owner");
  t.labels.add(id, "voice", "owner");
  expect(t.labels.remove(id, " billing ")).toEqual([{ name: "voice", by: "owner" }]);
  expect(refusal(() => t.labels.remove(id, "billing"))).toEqual(['That thread has no label "billing".', 400]);
});

test("a thread that is not a manager thread, or is not there, is refused; an archived one takes labels", () => {
  const t = setup("md-thl-thread-");
  const worker = t.store.getOrCreateThread("worker", "wkr_1").id;
  expect(refusal(() => t.labels.add("thr_x", "billing", "owner"))).toEqual(["No such thread: thr_x.", 404]);
  expect(refusal(() => t.labels.add(worker, "billing", "owner"))).toEqual([`No such thread: ${worker}.`, 404]);
  expect(refusal(() => t.labels.remove("thr_x", "billing"))).toEqual(["No such thread: thr_x.", 404]);
  const archived = t.thread("Old research");
  t.store.archiveThread(archived);
  expect(t.labels.add(archived, "billing", "agent")).toEqual([{ name: "billing", by: "agent" }]);
});

test("each change publishes the thread; an add that changes nothing does not", () => {
  const t = setup("md-thl-publish-");
  const id = t.thread("Billing research");
  t.labels.add(id, "billing", "owner");
  t.labels.add(id, "Billing", "owner");
  t.labels.add(id, "billing", "agent");
  expect(t.published).toEqual([id]);
  t.labels.remove(id, "billing");
  expect(t.published).toEqual([id, id]);
});

test("a thread's DTO and the archived list carry its labels", () => {
  const t = setup("md-thl-dto-");
  const open = t.thread("Billing research");
  const old = t.thread("Old research");
  t.labels.add(open, "billing", "owner");
  t.labels.add(old, "voice", "agent");
  t.store.archiveThread(old);
  const threads = new ManagerThreadService({ agentStore: t.store });
  expect(threads.dto(open)?.labels).toEqual([{ name: "billing", by: "owner" }]);
  expect(threads.dto(t.thread("Unlabelled"))?.labels).toEqual([]);
  const deletion = new ThreadDeletion({ db: t.env.store.db, agentStore: t.store, canvases: new CanvasStore(t.env.store.db, t.env.dir) });
  expect(deletion.archivedThreads().map((a) => [a.id, a.labels])).toEqual([[old, [{ name: "voice", by: "agent" }]]]);
});

test("labels go with their thread when it is deleted", () => {
  const t = setup("md-thl-deleted-");
  const gone = t.thread("Old research");
  const kept = t.thread("Billing research");
  t.labels.add(gone, "voice", "owner");
  t.labels.add(kept, "billing", "owner");
  t.store.archiveThread(gone);
  const deletion = new ThreadDeletion({ db: t.env.store.db, agentStore: t.store, canvases: new CanvasStore(t.env.store.db, t.env.dir) });
  expect(deletion.delete(gone)).toMatchObject({ ok: true });
  expect(t.env.store.db.prepare("select thread_id, name from thread_labels").all()).toEqual([{ thread_id: kept, name: "billing" }]);
});

test("the routes add and remove a label, answering with the thread's labels", async () => {
  const t = setup("md-thl-routes-");
  const id = t.thread("Billing research");
  const hono = new Hono();
  mountAgentsRoutes(hono, { agentStore: t.store, threadLabels: t.labels } as never);
  const path = `/api/agents/manager/threads/${id}/labels`;
  const added = await postJson(hono, path, { name: "billing" });
  expect([added.status, added.body]).toEqual([200, { labels: [{ name: "billing", by: "owner" }] }]);
  const long = await postJson(hono, path, { name: "x".repeat(41) });
  expect([long.status, long.body]).toEqual([400, { error: "A label is a word or two: at most 40 characters." }]);
  expect((await postJson(hono, path, { name: 7 })).status).toBe(400);
  const missing = await postJson(hono, "/api/agents/manager/threads/thr_x/labels", { name: "billing" });
  expect([missing.status, missing.body]).toEqual([404, { error: "No such thread: thr_x." }]);
  const removed = await deleteJson(hono, `${path}/${encodeURIComponent("Billing")}`);
  expect([removed.status, removed.body]).toEqual([200, { labels: [] }]);
  expect((await deleteJson(hono, `${path}/billing`)).status).toBe(400);
});
