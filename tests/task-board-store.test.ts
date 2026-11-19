import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import type { ThreadDot } from "../src/shared/thread-dot.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup(prefix: string) {
  env = freshStoresEnv(prefix);
  const events: Array<[string, unknown]> = [];
  let now = Date.parse("2026-11-09T09:00:00.000Z");
  const service = new TaskBoardService({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: { emit: (event: string, data: unknown) => { events.push([event, data]); } } as never,
    threadDots: () => new Map<string, ThreadDot>(),
    now: () => now
  });
  return { env, service, events, advance: (ms: number) => { now += ms; }, at: () => now };
}

test("a status change writes one line, by its author; the same status writes nothing", () => {
  const { service, events } = setup("md-tb-status-");
  const task = service.create({ title: "Print a receipt per order" }, "owner");
  expect(task.id).toMatch(/^tsk_/);
  const first = service.setStatus(task.id, "progress", "owner");
  expect(first.changed).toBe(true);
  expect(first.task.status).toBe("progress");
  const entries = service.detail(task.id)!.entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ kind: "status", by: "owner", status: "progress" });
  const emitted = events.length;
  const again = service.setStatus(task.id, "progress", "owner");
  expect(again.changed).toBe(false);
  expect(service.detail(task.id)!.entries).toHaveLength(1);
  expect(events.length).toBe(emitted);
});

test("the agent's move is its comment, the note required", () => {
  const { service } = setup("md-tb-agent-move-");
  const task = service.create({ title: "Pantry page prices" }, "owner");
  service.setStatus(task.id, "review", "agent", "Comparison ready");
  expect(service.detail(task.id)!.entries).toEqual([
    expect.objectContaining({ kind: "comment", by: "agent", status: "review", text: "Comparison ready" })
  ]);
  expect(() => service.setStatus(task.id, "progress", "agent")).toThrow("a note is required");
});

// The owner may tell the agent to close a task or open one again: its tool
// and its prompt keep it to that; the board takes the move with its note.
test("the agent sets Done or Cancelled with a note, which is its comment", () => {
  const { service } = setup("md-tb-agent-done-");
  const task = service.create({ title: "x" }, "owner");
  expect(() => service.setStatus(task.id, "done", "agent")).toThrow("a note is required");
  expect(service.setStatus(task.id, "done", "agent", "You said it is finished").task.status).toBe("done");
  expect(service.detail(task.id)!.entries.at(-1)).toEqual(expect.objectContaining({ kind: "comment", by: "agent", status: "done", text: "You said it is finished" }));
  expect(service.setStatus(task.id, "cancelled", "agent", "You dropped it").task.status).toBe("cancelled");
});

test("a Result is written and rewritten, each a line", () => {
  const { service } = setup("md-tb-result-");
  const task = service.create({ title: "x" }, "owner");
  service.writeResult(task.id, "First take.");
  service.writeResult(task.id, "Second take.\n\n- with a list");
  const detail = service.detail(task.id)!;
  expect(detail.result).toBe("Second take.\n\n- with a list");
  expect(detail.resultAt).not.toBe(null);
  expect(detail.entries.map((e) => [e.kind, e.text])).toEqual([["result", "wrote"], ["result", "updated"]]);
});

test("links are many to many and written once", () => {
  const { env, service } = setup("md-tb-links-");
  const thread = env.agentStore.createManagerThread("Bakery receipts per order");
  const a = service.create({ title: "Print receipts" }, "owner");
  const b = service.create({ title: "Release 3.21" }, "owner");
  expect(service.link(a.id, thread.id, { newThread: true })).toBe(true);
  expect(service.link(a.id, thread.id)).toBe(false);
  expect(service.link(b.id, thread.id)).toBe(true);
  const lines = service.detail(a.id)!.entries;
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ kind: "link", by: "agent", threadId: thread.id, threadTitle: "Bakery receipts per order", newThread: true });
  expect(service.tasksOfThread(thread.id).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  expect(service.detail(a.id)!.threads.map((t) => t.threadId)).toEqual([thread.id]);
  expect(service.unlink(a.id, thread.id)).toBe(true);
  expect(service.unlink(a.id, thread.id)).toBe(false);
  expect(service.detail(a.id)!.entries.map((e) => e.kind)).toEqual(["link", "unlink"]);
});

test("a long description is stored whole", () => {
  const { service } = setup("md-tb-long-");
  const description = "长".repeat(50_000) + "x".repeat(50_000);
  const task = service.create({ title: "Pasted brief", description }, "owner");
  expect(service.detail(task.id)!.description).toBe(description);
});

test("delete hides, restore brings back", () => {
  const { env, service } = setup("md-tb-delete-");
  const thread = env.agentStore.createManagerThread("t");
  const task = service.create({ title: "Gone for now" }, "owner");
  service.link(task.id, thread.id);
  service.comment(task.id, "a note", "owner");
  service.remove(task.id);
  expect(service.list().map((t) => t.id)).not.toContain(task.id);
  expect(service.list({ deleted: true }).map((t) => t.id)).toEqual([task.id]);
  service.restore(task.id);
  expect(service.list().map((t) => t.id)).toContain(task.id);
  expect(service.detail(task.id)!.entries.map((e) => e.kind)).toContain("comment");
});

// Kept until the owner deletes it forever: nothing takes a deleted task
// away by itself (the board's own ticks: task-notify.test.ts).
test("Delete forever takes a deleted task away with its lines, links and labels; its threads stay", () => {
  const { env, service, events } = setup("md-tb-forever-");
  const thread = env.agentStore.createManagerThread("t");
  const task = service.create({ title: "Gone for good" }, "owner");
  const other = service.create({ title: "Stays" }, "owner");
  service.link(task.id, thread.id);
  service.link(other.id, thread.id);
  service.comment(task.id, "a note", "owner");
  service.addLabel(task.id, "billing", "owner");
  // A task on the board is deleted first.
  expect(() => service.deleteForever(task.id)).toThrow(`no such task in Recently deleted: ${task.id}`);
  expect(service.detail(task.id)).not.toBe(null);
  service.remove(task.id);
  service.deleteForever(task.id);
  expect(service.detail(task.id)).toBe(null);
  expect(service.list({ deleted: true })).toEqual([]);
  const count = (table: string) => (env.store.db.prepare(`select count(*) as n from ${table} where task_id = ?`).get(task.id) as { n: number }).n;
  expect([count("task_board_threads"), count("task_board_entries"), count("task_board_labels")]).toEqual([0, 0, 0]);
  expect(env.agentStore.getThreadById(thread.id)).not.toBe(null);
  expect(service.detail(other.id)!.threads.map((t) => t.threadId)).toEqual([thread.id]);
  expect(events.some(([event, data]) => event === "taskBoardTaskRemoved" && (data as { id: string }).id === task.id)).toBe(true);
  // Gone: once more is a task that is not there.
  expect(() => service.deleteForever(task.id)).toThrow(`no such task: ${task.id}`);
});

test("delete all Done deletes only Done", () => {
  const { service } = setup("md-tb-done-");
  const done = service.create({ title: "done" }, "owner");
  const open = service.create({ title: "open" }, "owner");
  service.setStatus(done.id, "done", "owner");
  expect(service.removeAllDone()).toBe(1);
  expect(service.list().map((t) => t.id)).toEqual([open.id]);
});

test("renaming and dates write no line", () => {
  const { service } = setup("md-tb-edit-");
  const task = service.create({ title: "Old" }, "owner");
  const edited = service.edit(task.id, { title: "New", description: "Body", dueDate: "2026-11-20", dueTime: "14:00" });
  expect(edited).toMatchObject({ title: "New", description: "Body", dueDate: "2026-11-20", dueTime: "14:00" });
  service.edit(task.id, { dueDate: null, dueTime: null });
  expect(service.detail(task.id)).toMatchObject({ dueDate: null, dueTime: null, entries: [] });
});

test("an update is told once, after it is written", () => {
  const { service, events } = setup("md-tb-events-");
  const task = service.create({ title: "x" }, "owner");
  events.length = 0;
  service.comment(task.id, "hello", "owner");
  expect(events.map(([event]) => event)).toEqual(["taskBoardTaskUpdated"]);
  expect((events[0]![1] as { task: { lastComment: { text: string } } }).task.lastComment?.text).toBe("hello");
});

test("the agent opens a Done or Cancelled task again, with a note", () => {
  const { service } = setup("md-tb-reopen-");
  const done = service.create({ title: "done" }, "owner");
  service.setStatus(done.id, "done", "owner");
  expect(service.setStatus(done.id, "progress", "agent", "You asked to open it again").task.status).toBe("progress");
  const cancelled = service.create({ title: "cancelled" }, "owner");
  service.setStatus(cancelled.id, "cancelled", "owner");
  expect(service.setStatus(cancelled.id, "todo", "agent", "Back on").task.status).toBe("todo");
});
