import { expect, test } from "bun:test";
import { MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../src/server/modules/agent/wake-message-adapter.js";
import { fitOutputSoFar } from "../src/server/modules/agent/tools/bash.js";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bashTool, createBashTool, formatBashResult } from "../src/server/modules/agent/tools/bash.js";
import { type ShellProcess } from "../src/server/platform/process/shell-command-runner.js";
import type { BackgroundTaskDto } from "../src/shared/api-contracts.js";
import { COMMAND_LIMIT_REACHED, CommandLimitReached, commandMovedMessage, commandMoveRefusedMessage } from "../src/shared/command-messages.js";
import { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import { z } from "zod";
import { onCleanup } from "./helpers/cleanup.js";
import { stub, toolContext } from "./helpers/typed.js";
import type { ProjectRow } from "../src/server/modules/projects/projects-store.js";
import { testShellRunner } from "./helpers/shell-runner.js";

// Never let unit tests route through the module-level singleton runner: it
// captures the developer's real login shell (sourcing their rc files) and
// writes a snapshot into the real data dir. Tests get an isolated runner
// with a scratch HOME and snapshot dir instead.
const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "tool-bash-home-"));
const isolatedTool = createBashTool({
  runner: testShellRunner(isolatedHome)
});

const ctx = toolContext({
  threadId: "t",
  wakeId: "w",
  scope: {
    kind: "worker",
    feature: { workingDir: "/tmp" },
    project: { workingDir: "/tmp" }
  }
});

test("bashTool: captures stderr + non-zero exit", async () => {
  const r = await isolatedTool.handler({ command: "ls /no/such/path" }, ctx);
  expect(r).toContain("stderr:\n");
  expect(r).toMatch(/exitCode: [1-9]/);
});

test("bashTool: runs in the cwd it is given, the system temp dir too, outside the project's", async () => {
  const nonTmpCtx = {
    ...ctx,
    scope: {
      kind: "worker" as const,
      feature: { workingDir: path.resolve(".") },
      project: { workingDir: path.resolve(".") }
    }
  };
  const r = await isolatedTool.handler({ command: "pwd -P", cwd: os.tmpdir() }, nonTmpCtx);
  expect(r).toContain(`stdout:\n${realpathSync(os.tmpdir())}`);
  expect(r).toContain("exitCode: 0");
});

test("bashTool: supports an injectable shell command runner", async () => {
  const calls: Array<{ command: string; cwd: string; timeoutMs: number; maxOutputBytes?: number; keepTail?: boolean }> = [];
  const tool = createBashTool({
    runner: {
      spawn: async () => null,
      async run(command, options) {
        calls.push({ command, cwd: options.cwd, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, keepTail: options.keepTail });
        return { stdout: "runner", stderr: "", exitCode: 0, timedOut: false };
      }
    }
  });

  const r = await tool.handler({ command: "echo ignored", timeout: 123 }, ctx);

  expect(r).toContain("stdout:\nrunner");
  // Each stream is kept to 1 MiB while it runs.
  expect(calls).toStrictEqual([{ command: "echo ignored", cwd: "/tmp", timeoutMs: 123, maxOutputBytes: 1024 * 1024, keepTail: true }]);
});

// Models read "30s" and passed 30, which the runner took as 30 ms: the unit
// is stated where the model reads the timeout.
test("bashTool: a call that names no timeout waits up to 60 s", async () => {
  const waited: number[] = [];
  const tool = createBashTool({
    runner: {
      spawn: async () => null,
      async run(_command, options) {
        waited.push(options.timeoutMs);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }
    }
  });
  await tool.handler({ command: "true" }, ctx);
  expect(waited).toStrictEqual([60_000]);
});

test("bashTool: the model reads that timeout is in milliseconds, in the tool's description and on the parameter", () => {
  const tool = createBashTool({ runner: { run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }), spawn: async () => null } });
  expect(tool.description).toContain("timeout is in milliseconds: default 60000 (60 s), max 600000.");
  expect(tool.description).not.toContain("30s");
  const schema = z.toJSONSchema(tool.parameters) as { properties: Record<string, { description?: string }> };
  expect(schema.properties.timeout?.description).toBe("Timeout in milliseconds (default 60000, max 600000).");
});

test("bashTool: a command that prints more than 1 MiB keeps its start and its end, and says how much went between", async () => {
  const r = String(await isolatedTool.handler({ command: "printf HEAD; head -c 3000000 /dev/zero | tr '\\0' y; printf TAIL", timeout: 20_000 }, ctx));
  const omitted = 3_000_008 - 1024 * 1024;
  expect(r.startsWith("stdout:\nHEADyyy")).toBe(true);
  expect(r).toContain(`y\n... ${omitted} bytes omitted ...\ny`);
  expect(r.endsWith("yyyTAIL\nexitCode: 0")).toBe(true);
  expect(r.length).toBeLessThan(1024 * 1024 + 200);
});

test("bashTool: description points feature pane lifecycle to Mandate tools", () => {
  expect(bashTool.description).toMatch(/do not use bash to manage Mandate pane\s+lifecycle/);
  expect(bashTool.description).toMatch(/raw tmux/);
  expect(bashTool.description).toMatch(/spawn_pane/);
  expect(bashTool.description).toMatch(/kill_pane/);
});

test("bashTool: a description is offered to the model and does not change what runs", async () => {
  // The chat shows the description in place of the command, so the model has
  // to be asked for it — in the schema it is sent — and the handler must not
  // treat it as anything but a label.
  const schema = z.toJSONSchema(bashTool.parameters) as { properties: Record<string, { description?: string }>; required?: string[] };
  // What the description asks for: what the command does, not a restatement of it, how long, by example.
  const asked = schema.properties.description?.description ?? "";
  expect(asked).toMatch(/^A label for this command: the chat shows it where the command would be/);
  expect(asked).toMatch(/what the command is for, starting with a verb/);
  expect(asked).toMatch(/do not restate it: no flags, no file paths/);
  expect(asked).toMatch(/5-10 words/);
  // An everyday command and one that is hard to read: each told apart, and shown by example.
  expect(asked).toMatch(/An everyday command gets a plain label: /);
  expect(asked).toMatch(/One that is hard to read \(a pipeline, rare flags\) gets what it works out to: /);
  expect(asked).toContain('bun install -> "Install dependencies"');
  expect(asked).toContain('rg -l TODO src | xargs wc -l -> "Count lines in the files under src that mention TODO"');
  expect(schema.required ?? []).not.toContain("description");
  const args = bashTool.parameters.parse({ command: "echo hi", description: "Say hi" });
  const r = await isolatedTool.handler(args, ctx);
  expect(r).toContain("stdout:\nhi");
  expect(r).not.toContain("Say hi");
});

// `/\s+$/g` backtracks quadratically on a long run of whitespace that does not
// end the text; bash output is not capped, so 256KB of spaces before an "x"
// blocked the server for about 22s.
test("formatting a result trims trailing whitespace in linear time", () => {
  const out = `${" ".repeat(131_072)}x  \n\n`;
  const started = performance.now();
  const formatted = formatBashResult({ stdout: out, stderr: out, exitCode: 0 });
  expect(performance.now() - started).toBeLessThan(500);
  expect(formatted).toBe(`stdout:\n${" ".repeat(131_072)}x\nstderr:\n${" ".repeat(131_072)}x\nexitCode: 0`);
}, 60_000);

// Stop on a turn reaches the command it is running: the command and what it
// started in the background die at once, as at a timeout, and the call says
// what a call the stop never reached says.
test("bashTool: a stop kills the command and what it started, at once; the call says Stopped by user.", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tool-bash-stop-"));
  const pidFile = path.join(dir, "child.pid");
  const stop = new AbortController();
  const started = Date.now();
  const running = isolatedTool.handler(
    { command: `sleep 30 & echo $! > ${pidFile}; sleep 30`, timeout: 60_000 },
    { ...ctx, signal: stop.signal }
  );
  // Once the background sleep has started.
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  stop.abort();
  await expect(running).rejects.toThrow("Stopped by user.");
  expect(Date.now() - started).toBeLessThan(10_000);
  const alive = () => { try { process.kill(childPid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(alive()).toBe(false);
});

test("bashTool: the turn's stop is handed to the shell command runner", async () => {
  const stop = new AbortController();
  const seen: Array<AbortSignal | undefined> = [];
  const tool = createBashTool({
    runner: { run: async (_command, options) => { seen.push(options.signal); return { stdout: "", stderr: "", exitCode: 0, timedOut: false, stopped: false }; }, spawn: async () => null }
  });
  await tool.handler({ command: "true" }, { ...ctx, signal: stop.signal });
  expect(seen).toStrictEqual([stop.signal]);
});

test("bashTool: dispatched, a stopped call is the error Stopped by user., word for word", async () => {
  const registry = new ToolRegistry();
  registry.register(createBashTool({
    runner: { run: async () => ({ stdout: "half a build log", stderr: "", exitCode: -1, timedOut: false, stopped: true }), spawn: async () => null }
  }));
  const stop = new AbortController();
  stop.abort();
  const dispatched = await new ToolDispatcher(registry).dispatch({ toolCallId: "c1", toolName: "bash", args: { command: "make" } }, { ...ctx, signal: stop.signal });
  expect(dispatched).toEqual({ isError: true, error: "Stopped by user." });
});

test("bashTool: a command that ended by itself as the stop came keeps its own result", async () => {
  // It exits at once, but what it left in the background holds its output
  // open: the stop comes after its end and before its output closes.
  const stop = new AbortController();
  const started = Date.now();
  const running = isolatedTool.handler({ command: "sleep 3 & echo done", timeout: 60_000 }, { ...ctx, signal: stop.signal });
  await new Promise((r) => setTimeout(r, 400));
  stop.abort();
  expect(await running).toBe("stdout:\ndone\nexitCode: 0");
  // What it left is killed with it, so the call does not wait for it.
  expect(Date.now() - started).toBeLessThan(2_900);
});

test("bashTool: what a stopped command started is killed even when it ignores SIGTERM and its output went elsewhere", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tool-bash-stubborn-"));
  const pidFile = path.join(dir, "child.pid");
  const stop = new AbortController();
  const running = isolatedTool.handler(
    { command: `/bin/bash -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 30' >/dev/null 2>&1 & wait`, timeout: 60_000 },
    { ...ctx, signal: stop.signal }
  );
  for (let i = 0; i < 100 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()); i++) await new Promise((r) => setTimeout(r, 20));
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  const alive = () => { try { process.kill(childPid, 0); return true; } catch { return false; } };
  onCleanup(() => { if (alive()) process.kill(childPid, "SIGKILL"); });
  stop.abort();
  await expect(running).rejects.toThrow("Stopped by user.");
  for (let i = 0; i < 200 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(alive()).toBe(false);
});

// Background commands: with a command service the shell runs a command in
// the background, and moves one still running at its timeout there.

const runnerHome = mkdtempSync(path.join(os.tmpdir(), "tool-bash-bg-home-"));
const isolatedRunner = testShellRunner(runnerHome);
const commandTask = (id: string, command: string): BackgroundTaskDto => ({
  id, kind: "command", parentThreadId: "t", childThreadId: null, type: "general", title: command, status: "running", stoppedBy: null, error: null,
  createdAt: "2026-10-19T09:00:00.000Z", startedAt: "2026-10-19T09:00:00.000Z", finishedAt: null, seq: 1, exitCode: null, command, outputPath: `/out/${id}.log`
});
const fakeCommands = () => {
  const started: unknown[] = [];
  const adopted: Array<{ command: string; title: string; soFar: string; startedAgoMs: number }> = [];
  return {
    started, adopted,
    api: {
      start: async (input: { parentThreadId: string; command: string; title: string; cwd: string; owner: unknown }) => { started.push(input); return commandTask("task_bg", input.command); },
      adopt: async (input: { command: string; title: string; process: ShellProcess; soFar: Buffer; startedAt?: string }) => {
        adopted.push({ command: input.command, title: input.title, soFar: input.soFar.toString(), startedAgoMs: Date.now() - Date.parse(input.startedAt ?? "") });
        input.process.kill();
        return commandTask("task_mv", input.command);
      }
    }
  };
};

test("run_in_background returns at once with the task and its message", async () => {
  const c = fakeCommands();
  const tool = createBashTool({ runner: isolatedRunner, commands: c.api });
  const result = await tool.handler({ command: "make e2e", description: "Run the e2e suite", run_in_background: true }, ctx);
  expect(result).toEqual({
    taskId: "task_bg", status: "running", outputPath: "/out/task_bg.log",
    message: "Running in the background as task_bg; its output goes to /out/task_bg.log. You will be woken when it ends, with the end of its output. Until then you know nothing of how it went: do not report, assume or predict it, and do not wait for it with sleep or repeated reads. Carry on with other work, or end your turn. list_tasks shows what is running; stop_task stops it."
  });
  expect(c.started).toStrictEqual([{ parentThreadId: "t", command: "make e2e", title: "Run the e2e suite", cwd: "/tmp", owner: { kind: "global" } }]);
});

test("a background command with no description is named by its command, cut to 80 characters; a worker's output belongs to its project", async () => {
  const c = fakeCommands();
  const tool = createBashTool({ runner: isolatedRunner, commands: c.api });
  const long = `echo ${"x".repeat(100)}`;
  await tool.handler({ command: long, run_in_background: true }, toolContext({ ...ctx, project: stub<ProjectRow>({ id: "proj_1" }) }));
  expect(c.started).toStrictEqual([expect.objectContaining({ title: long.slice(0, 80), owner: { kind: "project", projectId: "proj_1" } })]);
});

test("a foreground command still running at its timeout moves to the background with its output so far", async () => {
  const c = fakeCommands();
  const tool = createBashTool({ runner: isolatedRunner, commands: c.api });
  const result = await tool.handler({ command: "printf 'early\\n'; sleep 5", description: "Wait a while", timeout: 300 }, ctx) as Record<string, unknown>;
  expect(result).toEqual({
    taskId: "task_mv", status: "running", outputPath: "/out/task_mv.log", movedAfterMs: 300, outputSoFar: "early",
    message: "Still running after 0 s, so it moved to the background as task_mv; its output goes to /out/task_mv.log (outputSoFar holds its end so far). You will be woken when it ends, with the end of its output. Until then you know nothing of how it went: do not report, assume or predict it, and do not wait for it with sleep or repeated reads."
  });
  expect(c.adopted).toStrictEqual([{ command: "printf 'early\\n'; sleep 5", title: "Wait a while", soFar: "early\n", startedAgoMs: expect.any(Number) }]);
  // Its clock starts when it did: as long before the move as its timeout.
  expect(Math.abs(c.adopted[0]!.startedAgoMs - 300)).toBeLessThan(150);
});

// Its whole output is in its file: the result keeps its task and as much of
// the output's end as leaves it within what the model is given inline, so it
// is never swapped for a preview (which would lose the task for the page).
test("a command moved with a long output so far keeps its task and the end that fits inline", async () => {
  const c = fakeCommands();
  const tool = createBashTool({ runner: isolatedRunner, commands: c.api });
  const line = "x".repeat(90);
  const command = `i=0; while [ $i -lt 700 ]; do printf '%05d ${line}\\n' $i; i=$((i+1)); done; sleep 5`;
  const result = await tool.handler({ command, timeout: 1500 }, ctx) as Record<string, unknown>;
  expect(result).toMatchObject({ taskId: "task_mv", status: "running" });
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  const soFar = result.outputSoFar as string;
  expect(soFar.endsWith(`00699 ${line}`)).toBe(true);
  expect(soFar.startsWith("0")).toBe(true);
  expect(soFar.length).toBeGreaterThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS - 2000);
});

test("fitting a moved command's output measures it as the model gets it: escapes cost, the newest stays, no character is split", () => {
  const moved = { taskId: "task_mv", status: "running" as const, outputPath: "/out/task_mv.log", movedAfterMs: 1000, message: "Moved." };
  // Each backslash is two characters once escaped: about half of them fit.
  const escaped = fitOutputSoFar({ ...moved, outputSoFar: `${"\\".repeat(30_000)}LATEST` });
  expect(JSON.stringify(escaped).length).toBeLessThanOrEqual(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(escaped.outputSoFar.endsWith("LATEST")).toBe(true);
  expect(escaped.outputSoFar.length).toBeGreaterThan(14_000);
  // No newline to cut at, and a pair of code units at every step.
  // Both alignments: one of them puts the earliest fitting start on a pair's second half.
  for (const lead of ["", "x"]) {
    const emoji = fitOutputSoFar({ ...moved, outputSoFar: `${lead}${"😀".repeat(20_000)}` });
    expect(JSON.stringify(emoji).length).toBeLessThanOrEqual(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
    expect(emoji.outputSoFar.charCodeAt(0)).toBe("😀".charCodeAt(0));
    expect(emoji.outputSoFar.length).toBeGreaterThan(29_000);
  }
  // A probe inside a pair must not skip a start that fits.
  const mixed = fitOutputSoFar({ ...moved, outputSoFar: `${"x".repeat(14_937)}\n😀${"\\".repeat(14_931)}\nLATEST` });
  expect(mixed.outputSoFar.startsWith("😀")).toBe(true);
  expect(JSON.stringify(mixed).length).toBeLessThanOrEqual(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  // Whole lines where there are lines.
  const lines = fitOutputSoFar({ ...moved, outputSoFar: Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, "0")} ${"y".repeat(40)}`).join("\n") });
  expect(lines.outputSoFar.startsWith("1")).toBe(true);
  expect(lines.outputSoFar.split("\n")[0]).toMatch(/^\d{4} y{40}$/);
  expect(lines.outputSoFar.endsWith(`1999 ${"y".repeat(40)}`)).toBe(true);
});

test("the moved message names the whole seconds it ran", () => {
  expect(commandMovedMessage("task_1", "/out/task_1.log", 60_000).split(";")[0]).toBe("Still running after 60 s, so it moved to the background as task_1");
  expect(commandMovedMessage("task_1", "/out/task_1.log", 1500).split(";")[0]).toBe("Still running after 2 s, so it moved to the background as task_1");
});

test("a command that starts with sleep is killed at its timeout, as before", async () => {
  const c = fakeCommands();
  const tool = createBashTool({ runner: isolatedRunner, commands: c.api });
  const result = await tool.handler({ command: "  sleep 5", timeout: 200 }, ctx);
  expect(String(result)).toContain("[bash: command timed out after 200ms]");
  expect(c.adopted).toStrictEqual([]);
});

test("without commands (a subagent, the dream) the schema has no run_in_background, the words are today's, and the timeout kills", async () => {
  const tool = createBashTool({ runner: isolatedRunner });
  const schema = z.toJSONSchema(tool.parameters) as { properties: Record<string, { description?: string }> };
  expect(Object.keys(schema.properties)).not.toContain("run_in_background");
  expect(schema.properties.timeout?.description).toBe("Timeout in milliseconds (default 60000, max 600000).");
  expect(tool.description).toBe(isolatedTool.description);
  expect(tool.description).not.toContain("run_in_background");
  const result = await tool.handler({ command: "printf 'early\\n'; sleep 5", timeout: 200 }, ctx);
  expect(String(result)).toContain("[bash: command timed out after 200ms]");
});

test("the description and parameters read word for word", () => {
  const tool = createBashTool({ runner: isolatedRunner, commands: fakeCommands().api });
  expect(tool.description).toBe("Run any shell command in the user's login shell environment (same PATH and env as their terminal). Returns a text transcript with stdout, stderr, and exit code. This is the default way to run project commands, long ones included; use panes only for interactive programs and for processes the user should watch or that keep running (dev servers, watchers). cwd defaults to the project working directory. timeout is in milliseconds: default 60000 (60 s), max 600000. A command still running at its timeout is not killed: it moves to the background, as with run_in_background (one that starts with `sleep` is killed). In feature scope, do not use bash to manage Mandate pane lifecycle via raw tmux; use spawn_pane, send_keys, read_pane, and kill_pane instead.");
  const schema = z.toJSONSchema(tool.parameters) as { properties: Record<string, { description?: string }> };
  expect(schema.properties.run_in_background?.description).toBe("Run the command in the background: the call returns at once with a taskId (no `&` needed), and the output goes to a file. You are woken when it ends, with the end of its output. For commands that end (builds, test suites, waiting on CI), not for interactive programs.");
  expect(schema.properties.timeout?.description).toBe("Timeout in milliseconds for a command in the foreground (default 60000, max 600000). At the timeout it moves to the background. A command in the background has none.");
});

// Your agent is one conversation: while its command runs in the foreground,
// the user cannot reach it. Its shell sets how long the foreground lasts.
test("a shell with a fixed foreground names no timeout, and its words say how long a command stays there", () => {
  const tool = createBashTool({ runner: isolatedRunner, commands: fakeCommands().api, foregroundMs: 30_000 });
  expect(tool.description).toBe("Run any shell command in the user's login shell environment (same PATH and env as their terminal). Returns a text transcript with stdout, stderr, and exit code. This is the default way to run project commands, long ones included; use panes only for interactive programs and for processes the user should watch or that keep running (dev servers, watchers). cwd defaults to the project working directory. A command still running after 30 s is not killed: it moves to the background, as with run_in_background (one that starts with `sleep` is killed). In feature scope, do not use bash to manage Mandate pane lifecycle via raw tmux; use spawn_pane, send_keys, read_pane, and kill_pane instead.");
  const schema = z.toJSONSchema(tool.parameters) as { properties: Record<string, unknown> };
  expect(Object.keys(schema.properties).sort()).toEqual(["command", "cwd", "description", "run_in_background"]);
});

test("with a fixed foreground a command moves at its end whatever timeout a call names, and a sleep is killed there", async () => {
  const c = fakeCommands();
  const tool = createBashTool({ runner: isolatedRunner, commands: c.api, foregroundMs: 300 });
  const moved = await tool.handler({ command: "printf 'early\\n'; sleep 5", timeout: 600_000 }, ctx);
  expect(moved).toMatchObject({ taskId: "task_mv", status: "running", movedAfterMs: 300, outputSoFar: "early" });
  const slept = await tool.handler({ command: "sleep 5", timeout: 600_000 }, ctx);
  expect(String(slept)).toContain("[bash: command timed out after 300ms]");
});

test("the limit is the tool's error for a start; a move refused at it is stopped, and its agent told so with its output so far", async () => {
  // As the service refuses a move: it kills the process, and rejects.
  const refused = {
    start: async () => { throw new CommandLimitReached(20); },
    adopt: async (input: { process: ShellProcess }) => { input.process.kill(); throw new CommandLimitReached(20); }
  };
  const tool = createBashTool({ runner: isolatedRunner, commands: refused });
  await expect(tool.handler({ command: "true", run_in_background: true }, ctx)).rejects.toThrow(COMMAND_LIMIT_REACHED);
  const dir = mkdtempSync(path.join(os.tmpdir(), "tool-bash-refused-"));
  const marker = path.join(dir, "still-ran");
  const result = await tool.handler({ command: `printf 'started\\n'; sleep 0.6; touch ${marker}`, timeout: 200 }, ctx);
  expect(result).toEqual({ status: "stopped", movedAfterMs: 200, outputSoFar: "started", message: commandMoveRefusedMessage(200, 20) });
  await new Promise((r) => setTimeout(r, 900));
  expect(existsSync(marker)).toBe(false);
});

test("the refused move says why it was stopped and what to do", () => {
  expect(commandMoveRefusedMessage(120_000, 20)).toBe("Still running after 120 s, and it could not move to the background: 20 background commands of this conversation are running. It was stopped (outputSoFar holds its end so far). Stop one (stop_task) or wait for one to end, then run it again.");
});

test("a move refused for any other reason is still the tool's error", async () => {
  const refused = {
    start: async () => { throw new Error("unused"); },
    adopt: async (input: { process: ShellProcess }) => { input.process.kill(); throw new Error("database is locked"); }
  };
  const tool = createBashTool({ runner: isolatedRunner, commands: refused });
  await expect(tool.handler({ command: "printf 'started\\n'; sleep 0.6", timeout: 200 }, ctx)).rejects.toThrow("database is locked");
});

test("a background start checks the cwd as a foreground call does: outside the scope, nothing starts", async () => {
  const c = fakeCommands();
  const tool = createBashTool({ runner: isolatedRunner, commands: c.api });
  const result = await tool.handler({ command: "true", cwd: "/nonexistent-dir-for-bash", run_in_background: true }, ctx);
  expect(String(result)).toContain("exitCode: -1");
  expect(c.started).toStrictEqual([]);
});
