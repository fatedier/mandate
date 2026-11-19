import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TmuxPipeManager } from "../src/server/runtime/runtimes/tmux-pipe-manager.js";
import type { CommandResult } from "../src/server/platform/process/command-runner.js";
import { tempDir } from "./helpers/temp.js";

/** At startup a Mandate clears pipe fifos left by earlier runs. Another
 *  Mandate on the same machine (a second instance, or e2e
 *  servers beside each other) shares the temp dir and the tmux server:
 *  its live fifos are not leftovers (a startup sweep froze
 *  another process's terminals). */
test("startup sweeps the fifos of processes that are gone and stops their panes' pipes; a live process's are left alone", async () => {
  const dir = tempDir("md-pipe-sweep-");
  const dead = 2 ** 22 + 1; // above any system's process ids: no such process
  const live = path.join(dir, `mandate-pipe-${process.pid}-_3-1790000000000.fifo`);
  const stale = path.join(dir, `mandate-pipe-${dead}-_7-1790000000000.fifo`);
  for (const file of [live, stale]) fs.writeFileSync(file, "");
  const commands: string[][] = [];
  const runner = { run: async (_binary: string, args: string[]): Promise<CommandResult> => { commands.push(args); return { status: 0, signal: null, stdout: "", stderr: "" }; } };
  await new TmuxPipeManager({ tmuxClient: { socketArgs: [], runner }, pipeDir: dir, pipePrefix: "mandate-pipe-4194000" }).sweepStalePipes();
  expect(fs.existsSync(live)).toBe(true);
  expect(fs.existsSync(stale)).toBe(false);
  expect(commands.sort()).toStrictEqual([["pipe-pane", "-t", "%7"]]);
});
