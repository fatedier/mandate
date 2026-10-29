import { expect, test } from "bun:test";
import { capturePanePreview, captureStaggerDelayMs } from "../src/server/platform/tmux/tmux-state.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";

// capture-pane -e keeps spaces that carry a colour (a TUI's background), so a
// capture can hold a long run of them before more text; `/\s+$/g` backtracked
// quadratically over such a run.
test("a captured pane is trimmed in linear time, however long a run of spaces inside it", async () => {
  const capture = `\x1b[44m${" ".repeat(131_072)}\x1b[0mstatus line  \n\n`;
  const client: TmuxClient = { socketArgs: [], runner: { run: () => ({ status: 0, signal: null, stdout: capture, stderr: "" }) } };
  const started = performance.now();
  const preview = await capturePanePreview("%1", 10, client);
  expect(performance.now() - started).toBeLessThan(500);
  expect(preview).toBe(`${" ".repeat(131_072)}status line`);
}, 60_000);

test("captureStaggerDelayMs keeps the first pane immediate and staggers later captures", () => {
  expect(captureStaggerDelayMs(0, () => 1)).toBe(0);
  expect(captureStaggerDelayMs(1, () => 0)).toBe(0);
  expect(captureStaggerDelayMs(1, () => 0.5)).toBe(20);
});
