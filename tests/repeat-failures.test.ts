import { expect, test } from "bun:test";
import {
  failureKey, maskError, RepeatFailureTracker, type RepeatVerdict, type ToolOutcome
} from "../src/server/modules/agent/repeat-failures.js";

const fail = (error = "can't find window @3", toolName = "spawn_pane", args: unknown = { cwd: "/w" }): ToolOutcome =>
  ({ toolName, args, isError: true, error });
const ok = (toolName: string, args: unknown = {}): ToolOutcome => ({ toolName, args, isError: false });

function run(tracker: RepeatFailureTracker, steps: ToolOutcome[][], threadId = "t1") {
  const verdicts: RepeatVerdict[] = [];
  for (const step of steps) {
    tracker.beginStep(threadId);
    for (const outcome of step) verdicts.push(tracker.record(threadId, outcome));
  }
  return verdicts;
}

test("the same failure nudges on the third and stops on the fifth", () => {
  const v = run(new RepeatFailureTracker(), [[fail()], [fail()], [fail()], [fail()], [fail()]]);
  expect(v.map((x) => x.count)).toStrictEqual([1, 2, 3, 4, 5]);
  expect(v.map((x) => x.nudge)).toStrictEqual([false, false, true, false, false]);
  expect(v.map((x) => x.stop)).toStrictEqual([false, false, false, false, true]);
});

test("a successful real call between failures resets the streak", () => {
  const v = run(new RepeatFailureTracker(), [[fail()], [fail()], [ok("edit")], [fail()], [fail()], [fail()], [fail()]]);
  expect(v.filter((x) => x.stop)).toHaveLength(0);
  expect(v.at(-1)!.count).toBe(4);
});

test("a bookkeeping success does not reset it: fail, set an alarm, fail … still stops", () => {
  const steps: ToolOutcome[][] = [];
  for (let i = 0; i < 5; i++) steps.push([fail()], [ok("schedule_wake", { delayMs: 60000 })]);
  const v = run(new RepeatFailureTracker(), steps);
  expect(v.some((x) => x.stop)).toBe(true);
});

test("a different error, different args or a different tool starts over", () => {
  const tracker = new RepeatFailureTracker();
  run(tracker, [[fail()], [fail()]]);
  expect(run(tracker, [[fail("permission denied")]])[0]!.count).toBe(1);
  expect(run(tracker, [[fail("permission denied", "spawn_pane", { cwd: "/x" })]])[0]!.count).toBe(1);
  expect(run(tracker, [[fail("permission denied", "kill_pane", { cwd: "/x" })]])[0]!.count).toBe(1);
});

test("identical calls issued together in one step count once", () => {
  const v = run(new RepeatFailureTracker(), [[fail(), fail(), fail()], [fail(), fail()]]);
  expect(v.map((x) => x.count)).toStrictEqual([1, 1, 1, 2, 2]);
  expect(v.some((x) => x.nudge || x.stop)).toBe(false);
});

test("reset (a person's message) clears the streak; threads are separate", () => {
  const tracker = new RepeatFailureTracker();
  run(tracker, [[fail()], [fail()]], "a");
  run(tracker, [[fail()]], "b");
  tracker.reset("a");
  expect(run(tracker, [[fail()]], "a")[0]!.count).toBe(1);
  expect(run(tracker, [[fail()]], "b")[0]!.count).toBe(2);
});

test("digits and ids are masked, nothing else", () => {
  expect(maskError("wake_Ed2rFv6tGb9 not found after 3 tries (id 0f3a9c2e1b)"))
    .toBe("<id> not found after <n> tries (id <id>)");
  expect(maskError("Thread Not Found")).toBe("Thread Not Found");
  expect(failureKey("t", { b: 1, a: [2, { d: 3, c: 4 }] }, "x")).toBe(failureKey("t", { a: [2, { c: 4, d: 3 }], b: 1 }, "x"));
  expect(failureKey("t", {}, "a")).not.toBe(failureKey("t", {}, "b"));
});

test("errors alike for their first 300 characters but different after are different failures", () => {
  // A test run's output: the same long header, a different failing test at the end.
  const header = "error: script \"test\" exited with code 1 — ".padEnd(320, "=");
  const a = failureKey("bash", { command: "bun test" }, `${header}\n(fail) parses the header`);
  const b = failureKey("bash", { command: "bun test" }, `${header}\n(fail) keeps the footer`);
  expect(a).not.toBe(b);
  const tracker = new RepeatFailureTracker();
  const verdicts = ["one", "two", "three", "four", "five"].map((name) => {
    tracker.beginStep("t");
    return tracker.record("t", { toolName: "bash", args: { command: "bun test" }, isError: true, error: `${header}\n(fail) ${name}` });
  });
  expect(verdicts.map((v) => v.count)).toEqual([1, 1, 1, 1, 1]);
});

test("a step's duplicate failure after another call's takes the streak back, from one", () => {
  // One step fails A, B, then A again: the step's last failure is A, so B's
  // later failures start over, and A's go on from one.
  const fail = (path: string): ToolOutcome => ({ toolName: "read", args: { path }, isError: true, error: "ENOENT" });
  const run = (steps: ToolOutcome[][]) => {
    const tracker = new RepeatFailureTracker();
    let last: RepeatVerdict = { nudge: false, stop: false, count: 0 };
    for (const outcomes of steps) {
      tracker.beginStep("t");
      for (const outcome of outcomes) last = tracker.record("t", outcome);
    }
    return { last, stopped: tracker.isStopped("t") };
  };
  const first = [fail("a"), fail("b"), fail("a")];
  expect(run([first, ...[1, 2, 3, 4].map(() => [fail("b")])])).toEqual({ last: { nudge: false, stop: false, count: 4 }, stopped: false });
  expect(run([first, ...[1, 2, 3, 4].map(() => [fail("a")])])).toEqual({ last: { nudge: false, stop: true, count: 5 }, stopped: true });
});
