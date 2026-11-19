import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { createTaskNotify, type TaskNotify } from "../src/server/modules/task-board/task-notify.js";
import type { NotifyRequest } from "../src/server/modules/notifications/notification-service.js";
import type { ScheduleClock } from "../src/server/modules/schedules/schedule-manager.js";

let env: StoresEnv | null = null;
let notify: TaskNotify | null = null;
afterEach(() => { notify?.stop(); notify = null; env?.cleanup(); env = null; });

const DAY_MS = 86_400_000;

/** A schedule clock moved on by hand; timers fire in order as it passes them. */
function manualClock(startIso: string): ScheduleClock & { advance(ms: number): void } {
  let now = Date.parse(startIso);
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    setInterval: () => { throw new Error("not used"); },
    clearInterval: () => {},
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    }
  };
}

function setup(prefix: string, startIso = "2026-11-09T08:00:00.000Z") {
  env = freshStoresEnv(prefix);
  const clock = manualClock(startIso);
  const sent: NotifyRequest[] = [];
  const settled: string[] = [];
  let hooks: TaskNotify | null = null;
  const board = new TaskBoardService({
    db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map(), now: () => clock.now(),
    onStatusChanged: (task, from, by) => hooks?.onStatusChanged(task, from, by),
    onRemoved: (id) => hooks?.onRemoved(id),
    onOpened: (id) => hooks?.onOpened(id)
  });
  hooks = createTaskNotify({
    notifications: {
      notify: (request) => { sent.push(request); return Promise.resolve({ line: "sent" }); },
      settle: (key) => { settled.push(key); return Promise.resolve(); }
    },
    taskBoard: board,
    clock,
    timeZone: () => "UTC",
    agentName: () => "Juno"
  });
  notify = hooks;
  const due = (title: string, dueDate: string | null) => board.create({ title, dueDate }, "owner");
  return { board, clock, sent, settled, notify: hooks, due };
}

test("the agent's move to In review notifies with the Result's first line", () => {
  const s = setup("md-tnotify-review-");
  const task = s.board.create({ title: "Book data from one source" }, "owner");
  s.board.writeResult(task.id, "**Picked** Atlas + grove.example.\n\nDetails below.");
  s.board.setStatus(task.id, "review", "agent", "Done; see the Result.");
  expect(s.sent).toEqual([{
    source: "system", level: "news",
    matter: { key: `task:${task.id}`, link: `/agent?task=${task.id}` },
    title: "Ready for review: Book data from one source",
    text: "Picked Atlas + grove.example."
  }]);
  // No Result yet: who moved it.
  const bare = s.board.create({ title: "Order flour" }, "owner");
  s.board.setStatus(bare.id, "review", "agent", "Please look.");
  expect(s.sent[1]).toMatchObject({ title: "Ready for review: Order flour", text: "Juno moved it to In review." });
});

test("the owner's move does not", () => {
  const s = setup("md-tnotify-owner-");
  const task = s.board.create({ title: "Book data from one source" }, "owner");
  s.board.setStatus(task.id, "review", "owner");
  s.board.setStatus(task.id, "progress", "agent", "Back on it.");
  expect(s.sent).toEqual([]);
});

test("opening or deleting the task withdraws it", () => {
  const s = setup("md-tnotify-settle-");
  const a = s.board.create({ title: "A" }, "owner");
  const b = s.board.create({ title: "B" }, "owner");
  s.board.opened(a.id);
  s.board.remove(b.id);
  expect(s.settled).toEqual([`task:${a.id}`, `task:${b.id}`]);
});

// Dragged to Done, or sent back to work, without being opened: what the
// notice asked for is settled, so it is taken back too.
test("leaving In review withdraws it, whoever moves it; other moves withdraw nothing", () => {
  const s = setup("md-tnotify-leave-");
  const a = s.board.create({ title: "A" }, "owner");
  const b = s.board.create({ title: "B" }, "owner");
  s.board.setStatus(a.id, "review", "agent", "Look.");
  s.board.setStatus(b.id, "review", "agent", "Look.");
  s.board.setStatus(a.id, "done", "owner");
  s.board.setStatus(b.id, "progress", "agent", "Back on it.");
  expect(s.settled).toEqual([`task:${a.id}`, `task:${b.id}`]);
  const c = s.board.create({ title: "C" }, "owner");
  s.board.setStatus(c.id, "progress", "owner");
  s.board.setStatus(c.id, "done", "owner");
  expect(s.settled).toHaveLength(2);
});

test("09:00 lists today's and overdue tasks in one notification", () => {
  const s = setup("md-tnotify-digest-");
  s.due("Order flour", "2026-11-09");
  s.due("Ship 3.21", "2026-11-09");
  s.due("Reply to vendor", "2026-11-07");
  s.due("Renew cert", "2026-11-08");
  s.due("Later thing", "2026-11-12");
  s.due("Someday", null);
  s.notify.start();
  expect(s.sent).toEqual([]);
  s.clock.advance(60 * 60 * 1000);
  expect(s.sent).toEqual([{
    source: "system", level: "news",
    matter: { key: "tasks:due", link: "/tasks" },
    title: "Due today: Order flour and 1 more",
    text: "2 overdue: Reply to vendor, Renew cert"
  }]);
});

test("one kind only: the other titles are the text", () => {
  const s = setup("md-tnotify-one-kind-");
  s.due("Reply to vendor", "2026-11-07");
  s.due("Renew cert", "2026-11-08");
  s.due("Old ask", "2026-11-01");
  s.notify.start();
  s.clock.advance(60 * 60 * 1000);
  expect(s.sent[0]).toMatchObject({ title: "Overdue: Old ask and 2 more", text: "Reply to vendor, Renew cert" });
});

test("a task kept in Backlog is not in the morning's notice", () => {
  const s = setup("md-tnotify-backlog-");
  s.due("Order flour", "2026-11-09");
  const kept = s.due("Someday maybe", "2026-11-07");
  s.board.setStatus(kept.id, "backlog", "owner");
  s.notify.start();
  s.clock.advance(60 * 60 * 1000);
  expect(s.sent).toEqual([expect.objectContaining({ title: "Due today: Order flour", text: "" })]);
});

test("nothing due, nothing sent", () => {
  const s = setup("md-tnotify-nothing-");
  s.due("Later thing", "2026-11-12");
  s.notify.start();
  s.clock.advance(60 * 60 * 1000);
  expect(s.sent).toEqual([]);
  expect(s.board.state().getState("digest_day")).toBe("2026-11-09");
});

test("a start after 09:00 sends the day's once", () => {
  const s = setup("md-tnotify-late-", "2026-11-09T10:30:00.000Z");
  s.due("Order flour", "2026-11-09");
  s.notify.start();
  expect(s.sent.map((r) => r.title)).toEqual(["Due today: Order flour"]);
  s.notify.stop();
  s.notify.start();
  expect(s.sent).toHaveLength(1);
});

/** Lets a notice's answer land. */
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("never twice a day", async () => {
  const s = setup("md-tnotify-daily-");
  s.due("Order flour", "2026-11-09");
  s.notify.start();
  s.clock.advance(60 * 60 * 1000);
  await flush();
  s.notify.stop();
  s.clock.advance(2 * 60 * 60 * 1000);
  s.notify.start();
  await flush();
  expect(s.sent).toHaveLength(1);
  // The next morning it is overdue, told once more.
  s.clock.advance(DAY_MS);
  await flush();
  expect(s.sent.map((r) => r.title)).toEqual(["Due today: Order flour", "Overdue: Order flour"]);
});

test("deleted and Done tasks are not listed", () => {
  const s = setup("md-tnotify-closed-");
  const done = s.due("Done one", "2026-11-09");
  s.board.setStatus(done.id, "done", "owner");
  const cancelled = s.due("Cancelled one", "2026-11-09");
  s.board.setStatus(cancelled.id, "cancelled", "owner");
  const gone = s.due("Deleted one", "2026-11-08");
  s.board.remove(gone.id);
  s.due("Still open", "2026-11-09");
  s.notify.start();
  s.clock.advance(60 * 60 * 1000);
  expect(s.sent.map((r) => [r.title, r.text])).toEqual([["Due today: Still open", ""]]);
});

// A deleted task is kept until the owner deletes it forever.
test("nothing deleted is taken away by the daily tick or a start, however long ago", () => {
  const s = setup("md-tnotify-keep-");
  const old = s.board.create({ title: "Old" }, "owner");
  s.board.remove(old.id);
  s.notify.start();
  s.clock.advance(400 * DAY_MS);
  s.notify.stop();
  s.notify.start();
  s.clock.advance(DAY_MS);
  expect(s.board.list({ deleted: true }).map((t) => t.id)).toEqual([old.id]);
});

// A notice nothing could show (no window yet, no channel, or the hourly
// limit) is not the day's notice: it is tried again.
test("the day's notice waits until something can show it", async () => {
  env = freshStoresEnv("md-tnotify-no-channel-");
  const clock = manualClock("2026-11-09T10:30:00.000Z");
  const board = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map(), now: () => clock.now() });
  board.create({ title: "Order flour", dueDate: "2026-11-09" }, "owner");
  const outcomes: Array<{ line: string; notSent?: "no_channel" | "limit" }> = [
    { line: "Not sent: no channel is set up.", notSent: "no_channel" },
    { line: "Not sent: the hourly limit is reached.", notSent: "limit" },
    { line: "Sent to the browser." }
  ];
  const tries: string[] = [];
  notify = createTaskNotify({
    notifications: {
      notify: (request) => { tries.push(request.title); return Promise.resolve(outcomes.shift() ?? { line: "Sent." }); },
      settle: () => Promise.resolve()
    },
    taskBoard: board, clock, timeZone: () => "UTC", agentName: () => "Juno"
  });
  notify.start();
  await flush();
  expect(tries).toHaveLength(1);
  expect(board.state().getState("digest_day")).toBe(null);
  clock.advance(5 * 60 * 1000);
  await flush();
  expect(tries).toHaveLength(2);
  expect(board.state().getState("digest_day")).toBe(null);
  clock.advance(5 * 60 * 1000);
  await flush();
  expect(tries).toEqual(["Due today: Order flour", "Due today: Order flour", "Due today: Order flour"]);
  expect(board.state().getState("digest_day")).toBe("2026-11-09");
  clock.advance(60 * 60 * 1000);
  await flush();
  expect(tries).toHaveLength(3);
});

// A retry is for its own day; past midnight it stops, and the next day's
// notice waits for its 09:00.
test("a notice tried again overnight does not take the next morning's place", async () => {
  env = freshStoresEnv("md-tnotify-overnight-");
  const clock = manualClock("2026-11-09T10:30:00.000Z");
  const board = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map(), now: () => clock.now() });
  board.create({ title: "Order flour", dueDate: "2026-11-09" }, "owner");
  let shown = false;
  const tries: Array<{ at: string; title: string }> = [];
  notify = createTaskNotify({
    notifications: {
      notify: (request) => {
        tries.push({ at: new Date(clock.now()).toISOString(), title: request.title });
        return Promise.resolve(shown ? { line: "Sent." } : { line: "Not sent: no channel is set up.", notSent: "no_channel" as const });
      },
      settle: () => Promise.resolve()
    },
    taskBoard: board, clock, timeZone: () => "UTC", agentName: () => "Juno"
  });
  const step = async (minutes: number) => {
    for (let i = 0; i < minutes; i += 5) {
      clock.advance(5 * 60 * 1000);
      for (let j = 0; j < 5; j++) await Promise.resolve();
    }
  };
  notify.start();
  await step(13 * 60 + 30); // to 00:00 on the 10th
  const beforeMidnight = tries.length;
  expect(tries.every((t) => t.at < "2026-11-10T00:00:00.000Z")).toBe(true);
  // A window opens at 08:00: nothing is sent before 09:00.
  await step(8 * 60);
  shown = true;
  await step(55);
  expect(tries.length).toBe(beforeMidnight);
  await step(10);
  expect(tries.at(-1)).toEqual({ at: "2026-11-10T09:00:00.000Z", title: "Overdue: Order flour" });
  expect(board.state().getState("digest_day")).toBe("2026-11-10");
}, 20_000);
