import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TmuxPipeManager } from "../src/server/runtime/runtimes/tmux-pipe-manager.js";
import type { CommandResult } from "../src/server/platform/process/command-runner.js";
import { spawnSync } from "node:child_process";
import { tempDir } from "./helpers/temp.js";

/** At startup a Mandate clears pipe fifos left by earlier runs. Another
 *  Mandate on the same machine (a second instance, or e2e
 *  servers beside each other) shares the temp dir and the tmux server:
 *  its live fifos are not leftovers (a startup sweep froze
 *  another process's terminals). */
test("startup sweeps the fifos of processes that are gone and stops their panes' pipes; a live process's are left alone", () => {
  const dir = tempDir("md-pipe-sweep-");
  const dead = spawnSync("true").pid; // ran and exited
  const live = path.join(dir, `mandate-pipe-${process.pid}-_3-1790000000000.fifo`);
  const stale = path.join(dir, `mandate-pipe-${dead}-_7-1790000000000.fifo`);
  const staleSocket = path.join(dir, `mandate-pipe-${dead}-_8-1790000000000.sock`);
  for (const file of [live, stale, staleSocket]) fs.writeFileSync(file, "");
  const commands: string[][] = [];
  const runner = { run: (_binary: string, args: string[]): CommandResult => { commands.push(args); return { status: 0, signal: null, stdout: "", stderr: "" }; } };
  new TmuxPipeManager({ tmuxClient: { socketArgs: [], runner }, pipeDir: dir, pipePrefix: "mandate-pipe-4194000" }).sweepStalePipes();
  expect(fs.existsSync(live)).toBe(true);
  expect(fs.existsSync(stale)).toBe(false);
  expect(fs.existsSync(staleSocket)).toBe(false);
  expect(commands.sort()).toStrictEqual([["pipe-pane", "-t", "%7"], ["pipe-pane", "-t", "%8"]]);
});
