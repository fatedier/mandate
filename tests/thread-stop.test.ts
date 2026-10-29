import { expect, test } from "bun:test";
import { threadDot, threadStop, workerStop, type ThreadWorkerSignal } from "../src/shared/thread-dot.js";

const w = (over: Partial<ThreadWorkerSignal> = {}): ThreadWorkerSignal => ({ waiting: null, running: false, watching: null, ...over });
const idle = { running: false, failed: false, watching: false };

test("a thread has not stopped while its manager or any worker runs, or waits on a monitor", () => {
  expect(threadStop({ ...idle, running: true }, [])).toBeNull();
  expect(threadStop(idle, [w(), w({ running: true })])).toBeNull();
  expect(threadStop({ ...idle, watching: true }, [])).toBeNull();
  expect(threadStop(idle, [w({ watching: "command" })])).toBeNull();
  // Its manager asked the user and works on: the thread already needs you, and has not stopped.
  expect(threadStop({ ...idle, running: true, asking: true }, [])).toBeNull();
});

test("stopped, it says how, in this order: failed, needs you, stopped", () => {
  expect(threadStop({ ...idle, failed: true }, [w({ asking: true }), w({ waiting: "stopped" })])).toBe("failed");
  expect(threadStop({ ...idle, failed: true, asking: true }, [])).toBe("failed");
  // Needs you: its manager asked the user; a worker's question nobody took up.
  expect(threadStop({ ...idle, asking: true }, [w({ waiting: "failed" })])).toBe("needs_you");
  expect(threadStop(idle, [w({ waiting: "failed" }), w({ asking: true })])).toBe("needs_you");
  // A worker's failure or stop, or its finished plan, is its manager's.
  expect(threadStop(idle, [w({ waiting: "failed" })])).toBe("stopped");
  expect(threadStop(idle, [w({ waiting: "stopped" })])).toBe("stopped");
  expect(threadStop(idle, [w()])).toBe("stopped");
  expect(threadStop(idle, [])).toBe("stopped");
});

// A worker's question goes to its manager first. It is the thread's to show
// only once nothing in the thread moves or will wake by itself: then only the
// user can move it. A worker's failure is its manager's, and marks nothing.
test("a worker's question marks its thread only once the whole thread rests; a failed worker marks nothing", () => {
  const asking = w({ asking: true });
  expect(threadDot({ ...idle, running: true }, [asking])).toBe("working");
  expect(threadDot(idle, [asking, w({ running: true })])).toBe("working");
  expect(threadDot(idle, [asking, w({ watching: "command" })])).toBe("watching");
  expect(threadDot({ ...idle, watching: true }, [asking])).toBe("watching");
  expect(threadDot(idle, [asking])).toBe("needs_you");
  expect(threadDot(idle, [asking, w({ waiting: "failed" })])).toBe("needs_you");
  // The asking worker still running its own turn is a thread at work.
  expect(threadDot(idle, [w({ asking: true, running: true })])).toBe("working");
  expect(threadDot(idle, [w({ waiting: "failed" }), w({ running: true })])).toBe("working");
  expect(threadStop(idle, [w({ waiting: "failed" }), w({ running: true })])).toBeNull();
});

test("its manager's own question marks the thread the moment it is asked, running or not", () => {
  expect(threadDot({ ...idle, asking: true }, [])).toBe("needs_you");
  expect(threadDot({ ...idle, running: true, asking: true }, [w({ running: true })])).toBe("needs_you");
  expect(threadDot({ ...idle, watching: true, asking: true }, [])).toBe("needs_you");
  expect(threadDot({ ...idle, asking: false }, [])).toBe("idle");
});

test("a worker on its own: running or watching is not stopped; then failed, needs you, stopped", () => {
  expect(workerStop(w({ running: true, asking: true }))).toBeNull();
  expect(workerStop(w({ watching: "pane" }))).toBeNull();
  expect(workerStop(w({ watching: "pane", asking: true }))).toBeNull();
  expect(workerStop(w({ waiting: "failed" }))).toBe("failed");
  expect(workerStop(w({ waiting: "failed", asking: true }))).toBe("failed");
  expect(workerStop(w({ asking: true }))).toBe("needs_you");
  expect(workerStop(w({ waiting: "stopped" }))).toBe("needs_you");
  expect(workerStop(w())).toBe("stopped");
});

test("threadDot: workers add only their running, their waits, and a resting thread's question; else idle", () => {
  expect(threadDot({ running: false }, [{ waiting: "stopped", running: false }])).toBe("idle");
  expect(threadDot({ running: false }, [{ waiting: "failed", running: false }])).toBe("idle");
  expect(threadDot({ running: true }, [{ waiting: "failed", running: false }])).toBe("working");
  expect(threadDot({ running: false }, [{ waiting: "stopped", running: false }, { waiting: null, asking: true, running: false }])).toBe("needs_you");
  expect(threadDot({ running: true }, [])).toBe("working");
  expect(threadDot({ running: false }, [{ waiting: null, running: true }])).toBe("working");
  expect(threadDot({ running: false }, [{ waiting: null, running: false }])).toBe("idle");
});

test("threadDot: a thread whose own turn failed is failed", () => {
  expect(threadDot({ running: false, failed: true }, [])).toBe("failed");
  expect(threadDot({ running: false, failed: true }, [{ waiting: "stopped", running: false }])).toBe("failed");
  expect(threadDot({ running: false, failed: false }, [])).toBe("idle");
});

// Watching: no agent runs a turn, but the manager or a worker
// waits on a monitor and will wake by itself. Below working, above idle;
// anything that wants the user still wins.
test("threadDot: watching when nothing runs but the manager or a worker waits on a monitor", () => {
  expect(threadDot({ running: false, watching: true }, [])).toBe("watching");
  expect(threadDot({ running: false }, [{ waiting: null, running: false, watching: "pane" }])).toBe("watching");
  expect(threadDot({ running: false }, [{ waiting: null, running: false, watching: "command" }])).toBe("watching");
  expect(threadDot({ running: true, watching: true }, [])).toBe("working");
  expect(threadDot({ running: false }, [{ waiting: null, running: true, watching: null }, { waiting: null, running: false, watching: "pane" }])).toBe("working");
  expect(threadDot({ running: false, watching: true }, [{ waiting: "failed", running: false, watching: null }])).toBe("watching");
  // A worker asleep on a monitor will wake by itself: its question is not yet the thread's to show.
  expect(threadDot({ running: false }, [{ waiting: null, asking: true, running: false, watching: "pane" }])).toBe("watching");
  expect(threadDot({ running: false }, [{ waiting: "failed", running: false, watching: "pane" }])).toBe("watching");
  expect(threadDot({ running: false, watching: false }, [{ waiting: null, running: false, watching: null }])).toBe("idle");
});

// A question is yellow and a failure red: one mark for both shows the
// thread's own failure. A worker's is its manager's.
test("threadDot: the thread's own failure outranks a question; a worker's never shows", () => {
  expect(threadDot({ ...idle, asking: true }, [w({ waiting: "failed" })])).toBe("needs_you");
  expect(threadDot({ ...idle, failed: true, asking: true }, [])).toBe("failed");
  expect(threadDot(idle, [w({ asking: true }), w({ waiting: "stopped" })])).toBe("needs_you");
});

// An alarm (schedule_wake) wakes its agent by itself, but it can as well be a
// reminder set past the end of the work. A worker's keeps the thread open only
// while that worker says it is still at work, a plan step in progress, and
// does not wait on the user.
test("a worker's alarm keeps its thread open only while a plan step is in progress and the user is not waited on", () => {
  expect(threadStop(idle, [w({ watching: "alarm", stepInProgress: true })])).toBeNull();
  expect(threadStop(idle, [w({ watching: "alarm" })])).toBe("stopped");
  expect(threadStop(idle, [w({ watching: "alarm", stepInProgress: true, waiting: "stopped" })])).toBe("stopped");
  expect(threadStop(idle, [w({ watching: "alarm", stepInProgress: true, asking: true })])).toBe("needs_you");
  expect(threadStop(idle, [w({ watching: "alarm", stepInProgress: true, waiting: "failed" })])).toBe("stopped");
  expect(workerStop(w({ watching: "alarm", stepInProgress: true }))).toBeNull();
  expect(workerStop(w({ watching: "alarm" }))).toBe("stopped");
  expect(workerStop(w({ watching: "alarm", stepInProgress: true, waiting: "failed" }))).toBe("failed");
  // Any other wait keeps it open, whatever its plan says.
  expect(threadStop(idle, [w({ watching: "pane" })])).toBeNull();
  expect(threadStop(idle, [w({ watching: "command", waiting: "stopped" })])).toBeNull();
  expect(workerStop(w({ watching: "subagent", waiting: "failed" }))).toBeNull();
});

// A manager has no plan that says it is still at work.
test("a manager's alarm never keeps its thread open; its other waits do", () => {
  expect(threadStop({ ...idle, watching: "alarm" }, [])).toBe("stopped");
  expect(threadStop({ ...idle, watching: "alarm" }, [w({ waiting: "stopped" })])).toBe("stopped");
  expect(threadStop({ ...idle, watching: "command" }, [])).toBeNull();
  expect(threadStop({ ...idle, watching: true }, [])).toBeNull();
});

test("an alarm that keeps nothing open does not hold a worker's question back, yet still shows as watching", () => {
  expect(threadDot(idle, [w({ asking: true, watching: "alarm", stepInProgress: true })])).toBe("needs_you");
  expect(threadDot({ ...idle, watching: "alarm" }, [w({ asking: true })])).toBe("needs_you");
  // Another worker still at work, its alarm a wait: the question waits for the thread.
  expect(threadDot(idle, [w({ asking: true }), w({ watching: "alarm", stepInProgress: true })])).toBe("watching");
  expect(threadDot({ ...idle, watching: "alarm" }, [])).toBe("watching");
  expect(threadDot(idle, [w({ watching: "alarm" })])).toBe("watching");
});
