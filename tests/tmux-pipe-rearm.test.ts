import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { TmuxPipeManager } from "../src/server/runtime/runtimes/tmux-pipe-manager.js";
import type { CommandResult } from "../src/server/platform/process/command-runner.js";
import { getLogLevel, setLogLevel } from "../src/server/platform/logger.js";
import { tempDir } from "./helpers/temp.js";

const done = (status: number): CommandResult => ({ status, signal: null, stdout: "", stderr: "" });

/** A re-arm tmux refuses is logged as one: with tmux's words, or its status
 *  when it says nothing, and the failure named once. */
test("a re-arm that tmux refuses without a word is logged once, with its status", async () => {
  const dir = tempDir("md-pipe-rearm-");
  // A plain file stands in for the fifo: its reader ends at once, as when
  // tmux stops the pipe, and a re-arm follows.
  const fifoRunner = { run: async (_binary: string, args: string[]) => { fs.writeFileSync(args[0]!, ""); return done(0); } };
  let arms = 0;
  const runner = { run: async (_binary: string, args: string[]) => done(args.includes("-O") && ++arms > 1 ? 1 : 0) };
  const lines: string[] = [];
  const logged = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const oldLevel = getLogLevel();
  setLogLevel("error");
  const manager = new TmuxPipeManager({ tmuxClient: { socketArgs: [], runner }, pipeDir: dir, pipePrefix: "mandate-pipe-rearm", fifoRunner });
  try {
    await manager.attachTerminalClient("%1", { readyState: 1, send() {}, close() {} } as never);
    const deadline = Date.now() + 5000;
    while (arms < 2 && Date.now() < deadline) await Bun.sleep(10);
    await Bun.sleep(20);
    expect(lines.filter((line) => line.includes("terminal pipe %1"))).toEqual(["[mandate] terminal pipe %1: tmux pipe-pane rearm failed: status 1"]);
  } finally {
    await manager.disposeAll();
    logged.mockRestore();
    setLogLevel(oldLevel);
  }
});
