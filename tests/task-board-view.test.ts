import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import type { ThreadDot } from "../src/shared/thread-dot.js";

const DAY = 24 * 3600 * 1000;
let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup(prefix: string) {
  env = freshStoresEnv(prefix);
  const dots = new Map<string, ThreadDot>();
  const events: Array<[string, unknown]> = [];
  let now = Date.parse("2026-11-09T09:00:00.000Z");
  const service = new TaskBoardService({
    db: env.store.db, agentStore: env.agentStore,
    sse: { emit: (event: string, data: unknown) => { events.push([event, data]); } } as never,
    threadDots: () => dots, now: () => now
  });
  return { env, service, dots, events, advance: (ms: number) => { now += ms; } };
}

function reply(env: StoresEnv, threadId: string, text: string) {
  env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text } });
}

test("needs you when a linked thread waits on the owner", () => {
  const { env, service, dots } = setup("md-tbv-needs-");
  const thread = env.agentStore.createManagerThread("Recipe book");
  const task = service.create({ title: "Scale recipes" }, "owner");
  service.link(task.id, thread.id);
  dots.set(thread.id, "needs_you");
  expect(service.detail(task.id)!.marks.needsYou).toBe(true);
  dots.set(thread.id, "decision");
  expect(service.detail(task.id)!.marks.needsYou).toBe(true);
  dots.set(thread.id, "result");
  expect(service.detail(task.id)!.marks).toEqual({ needsYou: false, failed: false, quiet: false });
});

test("failed when a linked thread failed", () => {
  const { env, service, dots } = setup("md-tbv-failed-");
  const thread = env.agentStore.createManagerThread("Release");
  const task = service.create({ title: "Release 3.21" }, "owner");
  service.link(task.id, thread.id);
  dots.set(thread.id, "failed");
  expect(service.detail(task.id)!.marks.failed).toBe(true);
});

test("a closed task carries no marks", () => {
  const { env, service, dots } = setup("md-tbv-closed-");
  const thread = env.agentStore.createManagerThread("t");
  const task = service.create({ title: "x" }, "owner");
  service.link(task.id, thread.id);
  dots.set(thread.id, "needs_you");
  service.setStatus(task.id, "done", "owner");
  expect(service.detail(task.id)!.marks).toEqual({ needsYou: false, failed: false, quiet: false });
});

test("quiet after three days without a line, In progress only", () => {
  const { service, advance } = setup("md-tbv-quiet-");
  const progress = service.create({ title: "In progress" }, "owner");
  const review = service.create({ title: "In review" }, "owner");
  service.setStatus(progress.id, "progress", "owner");
  service.setStatus(review.id, "review", "owner");
  advance(3 * DAY - 60_000);
  expect(service.detail(progress.id)!.marks.quiet).toBe(false);
  advance(2 * 60_000);
  expect(service.detail(progress.id)!.marks.quiet).toBe(true);
  expect(service.detail(review.id)!.marks.quiet).toBe(false);
  service.comment(progress.id, "still on it?", "owner");
  expect(service.detail(progress.id)!.marks.quiet).toBe(false);
});

test("a thread row is its dot and its latest reply's first line; a thread gone is left out", () => {
  const { env, service, dots } = setup("md-tbv-rows-");
  const live = env.agentStore.createManagerThread("Pantry page data source");
  const old = env.agentStore.createManagerThread("Old thread");
  const task = service.create({ title: "Prices from one source" }, "owner");
  service.link(task.id, live.id);
  service.link(task.id, old.id);
  reply(env, live.id, "## Comparing **three** grocery lists\n\nFoodList covers 90%.");
  dots.set(live.id, "working");
  env.agentStore.archiveThread?.(old.id);
  // A link to a thread id that no longer exists.
  env.store.db.prepare("insert into task_board_threads (task_id, thread_id, linked_at) values (?, 'thr_gone', '2026-11-01T00:00:00.000Z')").run(task.id);
  const rows = service.detail(task.id)!.threads;
  expect(rows.map((r) => r.threadId)).toEqual([live.id, old.id]);
  expect(rows[0]).toMatchObject({ title: "Pantry page data source", dot: "working", archived: false, lastReply: "Comparing three grocery lists" });
  expect(rows[0]!.lastReplyAt).not.toBe(null);
  expect(rows[1]).toMatchObject({ dot: "idle", lastReply: null });
});

test("unanswered counts the owner's comments after the agent's last entry", () => {
  const { service } = setup("md-tbv-unanswered-");
  const task = service.create({ title: "x" }, "owner");
  service.comment(task.id, "one", "owner");
  expect(service.detail(task.id)!.unanswered).toBe(1);
  service.comment(task.id, "ack", "agent");
  expect(service.detail(task.id)!.unanswered).toBe(0);
  service.comment(task.id, "two", "owner");
  service.comment(task.id, "three", "owner");
  expect(service.detail(task.id)!.unanswered).toBe(2);
  service.setStatus(task.id, "progress", "agent", "Started");
  expect(service.detail(task.id)!.unanswered).toBe(0);
});

test("the last comment, by author", () => {
  const { service } = setup("md-tbv-last-");
  const task = service.create({ title: "x" }, "owner");
  expect(service.detail(task.id)!.lastComment).toBe(null);
  service.comment(task.id, "mine", "owner");
  service.setStatus(task.id, "progress", "agent", "On it");
  expect(service.detail(task.id)!.lastComment).toMatchObject({ by: "agent", text: "On it" });
});

// When a task came into its status: its last move, or its creation. A
// comment or a Result does not move it. The board orders Done by it.
test("statusAt is when the task last moved, or when it was made", () => {
  const { service, advance } = setup("md-tbv-status-at-");
  const task = service.create({ title: "x" }, "owner");
  expect(service.detail(task.id)!.statusAt).toBe("2026-11-09T09:00:00.000Z");
  advance(60_000);
  service.setStatus(task.id, "progress", "owner");
  advance(60_000);
  service.comment(task.id, "a note", "owner");
  service.writeResult(task.id, "Done it.");
  expect(service.detail(task.id)!.statusAt).toBe("2026-11-09T09:01:00.000Z");
  advance(60_000);
  service.setStatus(task.id, "done", "agent", "You said it is finished");
  expect(service.list().find((t) => t.id === task.id)!.statusAt).toBe("2026-11-09T09:03:00.000Z");
});

test("a linked thread's turn end sends its tasks again", () => {
  const { env, service, events } = setup("md-tbv-changed-");
  const thread = env.agentStore.createManagerThread("t");
  const task = service.create({ title: "x" }, "owner");
  service.link(task.id, thread.id);
  events.length = 0;
  reply(env, thread.id, "Done for now.");
  service.threadChanged(thread.id);
  expect(events.map(([event]) => event)).toEqual(["taskBoardTaskUpdated"]);
  expect((events[0]![1] as { task: { threads: Array<{ lastReply: string }> } }).task.threads[0]!.lastReply).toBe("Done for now.");
  events.length = 0;
  service.threadChanged("thr_unlinked");
  expect(events).toEqual([]);
});
