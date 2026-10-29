import { expect, test } from "bun:test";
import { getPaneDisplayCommand as effectiveCommand } from "../../src/client/lib/render.js";
import {
  createLatestLookup,
  createProgramTracker,
  createWheelStepper,
  readsUnrequestedWheel,
  scrollRoute,
  sgrWheelReport
} from "../../src/client/hooks/terminal/terminal-scroll-routing.js";

test("a scroll goes to the history, to xterm's wheel handling, or to the program as wheel reports", () => {
  const route = (alternate: boolean, mouseTracking: boolean, readsWheel: boolean) =>
    scrollRoute({ alternate, mouseTracking: mouseTracking ? "vt200" : "none", readsWheel });
  expect({
    history: route(false, false, false),
    historyEvenForCodex: route(false, false, true),
    mouseAsked: route(true, true, false),
    mouseAskedByCodex: route(true, true, true),
    mouseAskedOnTheNormalScreen: route(false, true, false),
    fullScreen: route(true, false, false),
    codexFullScreen: route(true, false, true)
  }).toEqual({
    history: "history",
    historyEvenForCodex: "history",
    mouseAsked: "xterm",
    mouseAskedByCodex: "xterm",
    mouseAskedOnTheNormalScreen: "xterm",
    fullScreen: "xterm",
    codexFullScreen: "wheel-report"
  });
});

test("codex is the program known to read the wheel without asking; others are not", () => {
  expect(["codex", "zsh", "less", "node", "codex-helper", "", undefined].map(readsUnrequestedWheel))
    .toEqual([true, false, false, false, false, false, false]);
});

test("codex is recognised in the forms its launchers take", () => {
  // npm's launcher script, and the native binary it starts, named by target.
  expect(["codex.js", "codex.mjs", "codex-aarch64-apple-darwin", "codex-x86_64-unknown-linux-musl", "codex.py", "codexx"]
    .map(readsUnrequestedWheel)).toEqual([true, true, true, true, false, false]);
  expect(readsUnrequestedWheel(effectiveCommand({
    currentCommand: "node", foregroundProcesses: [{ command: "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js" }]
  }))).toBe(true);
});

test("a wheel report is SGR: 64 up, 65 down, at a 1-based cell", () => {
  expect([sgrWheelReport(-1, 20, 10), sgrWheelReport(1, 1, 1)]).toEqual(["\x1b[<64;20;10M", "\x1b[<65;1;1M"]);
});

test("the stepper turns lines of travel into whole steps and keeps the rest", () => {
  const stepper = createWheelStepper(3);
  expect([stepper.add(-2), stepper.add(-2), stepper.add(5), stepper.add(-7), stepper.add(0.5)]).toEqual([0, -1, 1, -2, 0]);
  stepper.reset();
  expect(stepper.add(2)).toBe(0);
});

test("X10 mouse mode reports no wheel, so a scroll takes the path of no mouse at all", () => {
  const route = (mouseTracking: "none" | "x10" | "vt200" | "drag" | "any", alternate: boolean, readsWheel = false) =>
    scrollRoute({ alternate, mouseTracking, readsWheel });
  expect([route("x10", false), route("x10", true), route("x10", true, true), route("drag", false), route("any", true)])
    .toEqual(["history", "xterm", "wheel-report", "xterm", "xterm"]);
});

test("the stepper starts over when the gesture's destination changes", () => {
  const stepper = createWheelStepper(3);
  expect(stepper.add(2, "wheel-report")).toBe(0);
  // Two lines left over for the program must not carry into the history.
  expect(stepper.add(2, "history")).toBe(0);
  expect(stepper.add(-2, "wheel-report")).toBe(0);
  expect(stepper.add(-1, "wheel-report")).toBe(-1);
});

test("of overlapping lookups only the latest one's answer is taken", async () => {
  const applied: string[] = [];
  const lookup = createLatestLookup<string>((value) => applied.push(value));
  let answerFirst!: (value: string) => void;
  let answerSecond!: (value: string) => void;
  lookup(new Promise((resolve) => { answerFirst = resolve; }));
  lookup(new Promise((resolve) => { answerSecond = resolve; }));
  answerSecond("less");
  await Bun.sleep(0);
  // The older lookup answers last, for a program that has since exited.
  answerFirst("codex");
  await Bun.sleep(0);
  expect(applied).toStrictEqual(["less"]);
});

test("in the alternate screen the program read on entering it outranks the snapshot", async () => {
  const tracker = createProgramTracker();
  tracker.setSnapshot("zsh");
  expect(tracker.readsWheel()).toBe(false);
  tracker.enterAlternate(Promise.resolve("codex"));
  await Bun.sleep(0);
  expect(tracker.readsWheel()).toBe(true);
  // A snapshot behind the live read (the wrapper seen, its child not yet).
  tracker.setSnapshot("node");
  expect(tracker.readsWheel()).toBe(true);
});

test("leaving the alternate screen goes back to the snapshot, and a late live answer is dropped", async () => {
  const tracker = createProgramTracker();
  tracker.setSnapshot("zsh");
  let answer!: (value: string) => void;
  tracker.enterAlternate(new Promise((resolve) => { answer = resolve; }));
  tracker.leaveAlternate();
  answer("codex");
  await Bun.sleep(0);
  expect(tracker.readsWheel()).toBe(false);
});
