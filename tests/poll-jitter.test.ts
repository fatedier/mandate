import { expect, test } from "bun:test";
import { jitteredPollDelayMs } from "../src/server/app/background-jobs.js";
import { captureStaggerDelayMs } from "../src/server/platform/tmux/tmux-state.js";

test("jitteredPollDelayMs spreads background polling around the base interval", () => {
  expect(jitteredPollDelayMs(2000, () => 0.5)).toBe(2000);
  expect(jitteredPollDelayMs(2000, () => 0)).toBe(1760);
  expect(jitteredPollDelayMs(2000, () => 1)).toBe(2240);
  expect(jitteredPollDelayMs(500, () => 0)).toBe(500);
});

test("captureStaggerDelayMs keeps the first pane immediate and staggers later captures", () => {
  expect(captureStaggerDelayMs(0, () => 1)).toBe(0);
  expect(captureStaggerDelayMs(1, () => 0)).toBe(0);
  expect(captureStaggerDelayMs(1, () => 0.5)).toBe(20);
});
