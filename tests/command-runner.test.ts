import { afterEach, expect, test } from "bun:test";
import { commandRunnerFrom } from "../src/server/platform/process/command-runner.js";

const logged: string[] = [];
const realError = console.error;
afterEach(() => { console.error = realError; logged.length = 0; });
function captureLog() {
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
}

function timedOut(): Error & { code: string } {
  return Object.assign(new Error("spawnSync tmux ETIMEDOUT"), { code: "ETIMEDOUT" });
}

test("a spawn that carries an error is a failure, even when it reports status 0 (Bun's lost-exit spin)", () => {
  captureLog();
  // What Bun 1.4.2 returns after spinning to its timeout: status 0, no output, ETIMEDOUT.
  const runner = commandRunnerFrom(() => ({ pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, error: timedOut() }) as never);
  const r = runner.run("tmux", ["has-session", "-t", "md"], { timeout: 1500 });
  expect(r.status).toBe(null);
  expect((r.error as { code?: string } | undefined)?.code).toBe("ETIMEDOUT");
  expect(r.stdout).toBe("");
  // Said in the log, with the command, so it shows if it happens on a running server.
  expect(logged.some((line) => line.includes("tmux has-session") && line.includes("ETIMEDOUT"))).toBe(true);
});

test("a spawn without an error keeps its status and output, and logs nothing", () => {
  captureLog();
  const ok = commandRunnerFrom(() => ({ pid: 1, output: [], stdout: "md\n", stderr: "", status: 0, signal: null }) as never);
  expect(ok.run("tmux", ["list-sessions"])).toEqual({ status: 0, signal: null, stdout: "md\n", stderr: "", error: undefined });
  const no = commandRunnerFrom(() => ({ pid: 1, output: [], stdout: "", stderr: "can't find session", status: 1, signal: null }) as never);
  expect(no.run("tmux", ["has-session", "-t", "gone"]).status).toBe(1);
  expect(logged).toStrictEqual([]);
});

test("a binary that is not installed fails without a timeout log line", () => {
  captureLog();
  const missing = Object.assign(new Error("spawnSync tmux ENOENT"), { code: "ENOENT" });
  const runner = commandRunnerFrom(() => ({ pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error: missing }) as never);
  expect(runner.run("tmux", ["-V"]).status).toBe(null);
  expect(logged).toStrictEqual([]);
});
