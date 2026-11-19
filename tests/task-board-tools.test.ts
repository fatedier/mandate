import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { buildTaskBoardTools } from "../src/server/modules/task-board/tools/task-board-tools.js";
import { renderTasksSection } from "../src/server/modules/task-board/task-text.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const NOW = Date.parse("2026-11-09T09:00:00.000Z");

function setup(prefix: string) {
  env = freshStoresEnv(prefix);
  const board = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map(), now: () => NOW });
  const tool = buildTaskBoardTools({ taskBoard: board, agentStore: env.agentStore, agentName: () => "Juno", timeZone: () => "UTC", now: () => NOW })[0]!;
  const personal = env.agentStore.getOrCreatePersonalThread();
  const call = (args: Record<string, unknown>) => tool.handler(args as never, toolContext({ threadId: personal.id, wakeId: "w1" }));
  return { env, board, tool, call, personal };
}

test("there is one tool, task_board", () => {
  const { tool } = setup("md-tbt-name-");
  expect(tool.name).toBe("task_board");
  expect(tool.description).toStartWith("The user's task board. Actions:");
});

test("create sets title, description and due, created by the agent", async () => {
  const { board, call } = setup("md-tbt-create-");
  const out = await call({ action: "create", title: "Group the menu by season", description: "From your message today.", dueDate: "2026-11-13", taskId: "", status: "" });
  expect(typeof out).toBe("string");
  const [task] = board.list();
  expect(task).toMatchObject({ title: "Group the menu by season", description: "From your message today.", dueDate: "2026-11-13", createdBy: "agent", status: "todo" });
  expect(out).toBe(`Group the menu by season (${task!.id}) · todo · due Nov 13`);
});

// A title is one line on the board and in every turn's context: a paragraph
// pasted as one would ride along each time.
test("a title is at most 200 characters, created or renamed", async () => {
  const { board, call } = setup("md-tbt-title-cap-");
  expect(await call({ action: "create", title: "x".repeat(201) })).toEqual({ error: "a task title is at most 200 characters" });
  expect(typeof await call({ action: "create", title: "x".repeat(200) })).toBe("string");
  const [task] = board.list();
  expect(() => board.edit(task!.id, { title: "y".repeat(201) })).toThrow("a task title is at most 200 characters");
  expect(board.edit(task!.id, { title: `  ${"y".repeat(200)}  ` }).title).toBe("y".repeat(200));
});

// The agent reads and writes one set of words, lowercase: backlog, todo, in
// progress, in review, done, cancelled. Backlog, done and cancelled, and
// moving a task out of them, only on the user's word: the prompt and the
// tool's text say so. The board stores its own names.
test("set_status takes the six words, needs a note, and closes and reopens a task", async () => {
  const { board, call } = setup("md-tbt-status-");
  const task = board.create({ title: "x" }, "owner");
  expect(await call({ action: "set_status", taskId: task.id, status: "in progress" })).toEqual({ error: "Say in one line why it moves: the note is your comment on the task." });
  expect(await call({ action: "set_status", taskId: task.id, status: "in progress", note: "Started a thread" })).toBe(`x (${task.id}) · in progress`);
  expect(board.detail(task.id)?.status).toBe("progress");
  expect(await call({ action: "set_status", taskId: task.id, status: "in review", note: "The work came back" })).toBe(`x (${task.id}) · in review`);
  expect(board.detail(task.id)?.status).toBe("review");
  expect(await call({ action: "set_status", taskId: task.id })).toEqual({ error: "status is backlog, todo, in progress, in review, done or cancelled" });
  expect(await call({ action: "set_status", taskId: task.id, status: "backlog", note: "You want it kept for later" })).toBe(`x (${task.id}) · backlog`);
  expect(board.detail(task.id)?.status).toBe("backlog");
  expect(await call({ action: "set_status", taskId: task.id, status: "done", note: "You said it is finished" })).toBe(`x (${task.id}) · done`);
  expect(board.detail(task.id)?.status).toBe("done");
  expect(await call({ action: "set_status", taskId: task.id, status: "in progress", note: "You asked to open it again" })).toBe(`x (${task.id}) · in progress`);
  expect(await call({ action: "set_status", taskId: task.id, status: "cancelled", note: "You dropped it" })).toBe(`x (${task.id}) · cancelled`);
  expect(board.detail(task.id)?.status).toBe("cancelled");
  // Closing needs its note like any move.
  expect(await call({ action: "set_status", taskId: task.id, status: "done" })).toEqual({ error: "Say in one line why it moves: the note is your comment on the task." });
});

test("the status parameter is one of the six words: not the board's own names, not a label", () => {
  const { tool } = setup("md-tbt-enum-");
  const ok = (status: string) => tool.parameters.safeParse({ action: "set_status", status }).success;
  expect(["backlog", "todo", "in progress", "in review", "done", "cancelled"].map(ok)).toEqual([true, true, true, true, true, true]);
  expect(["progress", "review", "In progress", "in_progress", "Done", "canceled"].map(ok)).toEqual([false, false, false, false, false, false]);
  expect(tool.description).toContain("- set_status: backlog, todo, in progress, in review, done or cancelled, with a one-line note that becomes your comment. backlog, done and cancelled, and moving a task out of them, only when the user tells you to for that task.");
  expect(tool.description).toContain("- list: the open tasks (includeClosed adds backlog, done and cancelled).");
});

// Backlog holds what the user keeps for later: not open, so not in the list
// the agent reads by default; includeClosed lists it with the closed ones.
test("a task in Backlog is left out of the open list and shown with includeClosed", async () => {
  const { board, call } = setup("md-tbt-backlog-");
  const now = board.create({ title: "Now" }, "owner");
  const later = board.create({ title: "Later" }, "owner");
  board.setStatus(later.id, "backlog", "owner");
  const open = await call({ action: "list" });
  expect(String(open)).toContain(`Now (${now.id})`);
  expect(String(open)).not.toContain("Later");
  expect(String(await call({ action: "list", includeClosed: true }))).toContain(`Later (${later.id}) · backlog`);
});

// Labels: the agent adds one only when it creates the task for the user or
// is asked; it reads them all, the automatic ones (where the task's threads'
// workers ran) marked, and cannot remove those.
test("add_label and remove_label; the line and the block show the labels, the automatic ones marked", async () => {
  env = freshStoresEnv("md-tbt-labels-");
  const ranIn = new Map<string, string[]>();
  const board = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map(), now: () => NOW, workRanIn: (ids) => ids.flatMap((id) => ranIn.get(id) ?? []) });
  const tool = buildTaskBoardTools({ taskBoard: board, agentStore: env.agentStore, agentName: () => "Juno", timeZone: () => "UTC", now: () => NOW })[0]!;
  const personal = env.agentStore.getOrCreatePersonalThread();
  const call = (args: Record<string, unknown>) => tool.handler(args as never, toolContext({ threadId: personal.id, wakeId: "w1" }));
  expect(tool.description).toContain("- add_label / remove_label: a label on the task (`label`), a word or two. Reuse the board's labels; add one only when you create the task for the user or they ask.");
  const thread = env.agentStore.createManagerThread("Bakery receipts");
  ranIn.set(thread.id, ["acme-bakery"]);
  const task = board.create({ title: "Print a receipt per order" }, "owner");
  board.link(task.id, thread.id);
  expect(await call({ action: "add_label", taskId: task.id, label: "billing" })).toBe(`Print a receipt per order (${task.id}) · todo · threads: Bakery receipts · labels: acme-bakery (automatic), billing`);
  expect(board.detail(task.id)!.labels).toEqual([{ name: "acme-bakery", by: "auto" }, { name: "billing", by: "agent" }]);
  const read = await call({ action: "read", taskId: task.id }) as string;
  expect(read.split("\n")[2]).toBe("Labels: acme-bakery (automatic), billing");
  expect(await call({ action: "remove_label", taskId: task.id, label: "acme-bakery" })).toEqual({ error: "\"acme-bakery\" is automatic: it comes from where the task's threads ran, and cannot be removed." });
  expect(await call({ action: "remove_label", taskId: task.id, label: "3.21" })).toEqual({ error: "That task has no label \"3.21\"." });
  expect(await call({ action: "add_label", taskId: task.id, label: "x".repeat(41) })).toEqual({ error: "A label is a word or two: at most 40 characters." });
  expect(await call({ action: "remove_label", taskId: task.id, label: "billing" })).toBe(`Print a receipt per order (${task.id}) · todo · threads: Bakery receipts · labels: acme-bakery (automatic)`);
});

test("write_result replaces and writes a line", async () => {
  const { board, call } = setup("md-tbt-result-");
  const task = board.create({ title: "x" }, "owner");
  await call({ action: "write_result", taskId: task.id, result: "First." });
  await call({ action: "write_result", taskId: task.id, result: "Second." });
  expect(board.detail(task.id)!.result).toBe("Second.");
  expect(board.detail(task.id)!.entries.map((e) => e.text)).toEqual(["wrote", "updated"]);
});

test("read shows description, Result, threads and unanswered comments", async () => {
  const { env, board, call } = setup("md-tbt-read-");
  const thread = env.agentStore.createManagerThread("Bakery receipts per order");
  const task = board.create({ title: "Print a receipt per order", description: "Per order, not per day.", dueDate: "2026-11-08" }, "owner");
  board.link(task.id, thread.id);
  board.comment(task.id, "3.21 waits for this.", "owner");
  const out = await call({ action: "read", taskId: task.id });
  expect(out).toBe([
    `[Task "Print a receipt per order" (${task.id})]`,
    "Status: todo · Due: Sun, Nov 8, overdue · Threads: Bakery receipts per order",
    "Labels: none",
    "Description:",
    "Per order, not per day.",
    "Result:",
    "none yet",
    "Comments not yet answered:",
    "- The user, Nov 9 09:00: 3.21 waits for this."
  ].join("\n"));
});

test("link_thread refuses a thread that is not a manager thread", async () => {
  const { board, call, personal } = setup("md-tbt-link-");
  const task = board.create({ title: "x" }, "owner");
  expect(await call({ action: "link_thread", taskId: task.id, threadId: personal.id })).toEqual({ error: "Only a manager thread can be linked to a task." });
  expect(await call({ action: "link_thread", taskId: task.id, threadId: "thr_nothere" })).toEqual({ error: "Only a manager thread can be linked to a task." });
});

test("list omits Done and Cancelled unless asked", async () => {
  const { board, call } = setup("md-tbt-list-");
  const open = board.create({ title: "Open one" }, "owner");
  const done = board.create({ title: "Done one" }, "owner");
  board.setStatus(done.id, "done", "owner");
  expect(await call({ action: "list" })).toBe(`Open one (${open.id}) · todo`);
  expect(await call({ action: "list", includeClosed: true })).toBe(`Open one (${open.id}) · todo\nDone one (${done.id}) · done`);
});

test("an unknown task id is refused", async () => {
  const { call } = setup("md-tbt-unknown-");
  expect(await call({ action: "read", taskId: "tsk_nothinghere" })).toEqual({ error: "No such task: tsk_nothinghere." });
  expect(await call({ action: "comment", taskId: "tsk_nothinghere", text: "hi" })).toEqual({ error: "No such task: tsk_nothinghere." });
});

test("the runtime section lists open tasks one per line", () => {
  const { env, board } = setup("md-tbt-section-");
  const thread = env.agentStore.createManagerThread("Bakery receipts per order");
  const task = board.create({ title: "Print a receipt per order", dueDate: "2026-11-08" }, "owner");
  board.link(task.id, thread.id);
  board.setStatus(task.id, "progress", "owner");
  board.comment(task.id, "one", "owner");
  board.comment(task.id, "two", "owner");
  const plain = board.create({ title: "Rework the login page" }, "owner");
  const closed = board.create({ title: "Shipped" }, "owner");
  board.setStatus(closed.id, "done", "owner");
  expect(renderTasksSection(board.list(), { timeZone: "UTC", now: NOW })).toBe([
    `Print a receipt per order (${task.id}) · in progress · due Nov 8, overdue · threads: Bakery receipts per order · 2 unanswered comments`,
    `Rework the login page (${plain.id}) · todo`
  ].join("\n"));
  expect(renderTasksSection([], { timeZone: "UTC", now: NOW })).toBe("No open tasks.");
});
