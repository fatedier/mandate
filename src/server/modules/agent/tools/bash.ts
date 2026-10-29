import { statSync } from "node:fs";
import { z } from "zod";
import { TOOL_CALL_STOPPED, type ToolContext, type ToolDefinition } from "../tool-registry.js";
import { assertReadInScope } from "../tool-scope.js";
import {
  nodeShellCommandRunner,
  type ShellCommandRunner,
  type ShellProcess
} from "../../../platform/process/shell-command-runner.js";
import { tailOfOutput } from "../../../platform/process/output-tail.js";
import { MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../wake-message-adapter.js";
import type { ResourceOwner } from "../../../platform/fs/resources.js";
import type { BackgroundCommandService } from "../../../runtime/background-commands.js";
import type { BackgroundTaskDto } from "../../../../shared/api-contracts.js";
import { COMMAND_LIMITS, CommandLimitReached, commandMovedMessage, commandMoveRefusedMessage, commandStartedMessage } from "../../../../shared/command-messages.js";

const params = z.object({
  command: z.string().min(1),
  // Read by the chat, not by the handler: the transcript shows this instead of
  // the command, which is often unreadable at a glance. Optional. Its
  // description says what to say, what not to repeat, how long, with examples.
  description: z.string().optional().describe(
    "A label for this command: the chat shows it where the command would be, to someone who may " +
    "never read the command. Say what the command is for, starting with a verb; do not restate it: " +
    "no flags, no file paths. 5-10 words. An everyday command gets a plain label: " +
    "bun install -> \"Install dependencies\"; bun test tests/chat-input.test.tsx -> \"Run the composer tests\"; " +
    "git log --oneline -5 -> \"Show the last five commits\". One that is hard to read (a pipeline, rare flags) " +
    "gets what it works out to: " +
    "rg -l TODO src | xargs wc -l -> \"Count lines in the files under src that mention TODO\"; " +
    "git fetch origin && git rebase origin/main -> \"Bring the branch up to date with main\"."
  ),
  cwd: z.string().optional(),
  // The unit is stated where the model reads it: told only "30s", models
  // passed 30, which ran as 30 ms.
  timeout: z.number().int().positive().max(600000).optional().describe(
    "Timeout in milliseconds (default 60000, max 600000)."
  )
});

/** The shell of an agent whose commands can run in the background: workers,
 *  managers and Your agent. */
const backgroundParams = params.extend({
  run_in_background: z.boolean().optional().describe(
    "Run the command in the background: the call returns at once with a taskId (no `&` needed), and the output goes to a file. " +
    "You are woken when it ends, with the end of its output. For commands that end (builds, test suites, waiting on CI), not for interactive programs."
  ),
  timeout: z.number().int().positive().max(600000).optional().describe(
    "Timeout in milliseconds for a command in the foreground (default 60000, max 600000). At the timeout it moves to the background. A command in the background has none."
  )
});

/** A shell whose foreground lasts a fixed time: no timeout to set. */
const fixedForegroundParams = backgroundParams.omit({ timeout: true });

type BashArgs = z.infer<typeof backgroundParams>;

/** How long a command may run when its call names no timeout. */
const BASH_DEFAULT_TIMEOUT_MS = 60_000;

/** A command that only waits is killed at its timeout, never moved. */
const WAITS_ONLY = /^\s*sleep\b/;

/** A transcript; or, for a command in the background, its task. */
type BashResult =
  | string
  | { taskId: string; status: "running"; outputPath: string | null; message: string }
  | { taskId: string; status: "running"; outputPath: string | null; movedAfterMs: number; outputSoFar: string; message: string }
  | { status: "stopped"; movedAfterMs: number; outputSoFar: string; message: string };

interface BashToolDeps {
  runner?: ShellCommandRunner;
  /** Background commands. Without them (a subagent, the dream): no
   *  run_in_background, and the timeout kills. */
  commands?: Pick<BackgroundCommandService, "start" | "adopt"> | null;
  /** With commands: how long a command runs in the foreground before it
   *  moves to the background, set here rather than by the call (Your agent:
   *  while its command runs in the foreground, the user cannot reach it). */
  foregroundMs?: number;
}

/** What the bash tool keeps of each stream while a command runs: its first and
 *  last 512KB. A command printing
 *  without end (`yes`, a huge log) no longer grows the server's memory; larger
 *  results still go to a file the agent can read (tool-output-spool.ts). */
const BASH_OUTPUT_MAX_BYTES = 1024 * 1024;

const DESCRIPTION =
  "Run any shell command in the user's login shell environment (same PATH " +
  "and env as their terminal). Returns a text transcript with stdout, " +
  "stderr, and exit code. This is the default way to run project commands; " +
  "use panes only for interactive CLIs and long-running processes. " +
  "cwd defaults to the project working directory. " +
  "timeout is in milliseconds: default 60000 (60 s), max 600000. " +
  "In feature scope, do not use bash to manage Mandate pane " +
  "lifecycle via raw tmux; use spawn_pane, send_keys, " +
  "read_pane, and kill_pane instead.";

/** The words of a shell whose commands can run in the background; `moves`
 *  says when a foreground command moves there. */
const backgroundDescription = (moves: string) =>
  "Run any shell command in the user's login shell environment (same PATH and env as their terminal). " +
  "Returns a text transcript with stdout, stderr, and exit code. " +
  "This is the default way to run project commands, long ones included; use panes only for interactive programs " +
  "and for processes the user should watch or that keep running (dev servers, watchers). " +
  `cwd defaults to the project working directory. ${moves} ` +
  "In feature scope, do not use bash to manage Mandate pane lifecycle via raw tmux; use spawn_pane, send_keys, read_pane, and kill_pane instead.";

const BACKGROUND_DESCRIPTION = backgroundDescription(
  "timeout is in milliseconds: default 60000 (60 s), max 600000. " +
  "A command still running at its timeout is not killed: it moves to the background, as with run_in_background " +
  "(one that starts with `sleep` is killed)."
);

const fixedForegroundDescription = (ms: number) => backgroundDescription(
  `A command still running after ${Math.round(ms / 1000)} s is not killed: it moves to the background, as with run_in_background ` +
  "(one that starts with `sleep` is killed)."
);

/** Where a command's output file goes: the project's resources for a
 *  project's agent, else the global ones (as the tool-output spool decides). */
function ownerOf(ctx: ToolContext): ResourceOwner {
  return ctx.project ? { kind: "project", projectId: ctx.project.id } : { kind: "global" };
}

export function createBashTool(deps: BashToolDeps = {}): ToolDefinition<BashArgs, BashResult> {
  const runner = deps.runner ?? nodeShellCommandRunner;
  const commands = deps.commands ?? null;
  const foregroundMs = commands ? deps.foregroundMs ?? null : null;
  return {
    name: "bash",
    description: foregroundMs !== null ? fixedForegroundDescription(foregroundMs) : commands ? BACKGROUND_DESCRIPTION : DESCRIPTION,
    parameters: foregroundMs !== null ? fixedForegroundParams : commands ? backgroundParams : params,
    handler: async ({ command, description, cwd, timeout, run_in_background }, ctx) => {
      const requestedCwd =
        cwd ??
        (ctx.scope?.kind === "worker"
          ? (ctx.scope.feature?.workingDir ?? ctx.scope.project.workingDir)
          : (ctx.scope?.managerDir ?? process.cwd()));
      let effectiveCwd: string;
      try {
        effectiveCwd = assertReadInScope(requestedCwd, ctx.scope);
      } catch (err) {
        return formatBashResult({ stdout: "", stderr: (err as Error).message, exitCode: -1 });
      }
      // Pre-flight: ensure cwd is an actual directory before spawning. Node's
      // child_process emits a confusingly-worded ENOENT here that names the
      // executable when really the missing path is the cwd.
      try {
        const st = statSync(effectiveCwd);
        if (!st.isDirectory()) {
          return formatBashResult({ stdout: "", stderr: `cwd is not a directory: ${effectiveCwd}`, exitCode: -1 });
        }
      } catch {
        return formatBashResult({ stdout: "", stderr: `cwd does not exist: ${effectiveCwd}`, exitCode: -1 });
      }
      // A background command is named in the chat and in its task by its
      // description, else by its command.
      const title = description?.trim() || command.slice(0, 80);
      if (commands && run_in_background) {
        const task = await commands.start({ parentThreadId: ctx.threadId, command, title, cwd: effectiveCwd, owner: ownerOf(ctx) });
        return { taskId: task.id, status: "running", outputPath: task.outputPath, message: commandStartedMessage(task.id, task.outputPath ?? "") };
      }
      const timeoutMs = foregroundMs ?? timeout ?? BASH_DEFAULT_TIMEOUT_MS;
      // Moved at its timeout: the service takes it over (refused, it kills it).
      let moving: { task: Promise<BackgroundTaskDto>; soFar: Buffer } | null = null;
      const receive = commands && !WAITS_ONLY.test(command)
        ? (process: ShellProcess, soFar: Buffer) => {
            // Its clock runs from its start: the timeout before the move.
            const startedAt = new Date(Date.now() - timeoutMs).toISOString();
            const task = commands.adopt({ parentThreadId: ctx.threadId, command, title, owner: ownerOf(ctx), process, soFar, startedAt });
            // Read below, once the call has resolved; never left unhandled.
            task.catch(() => {});
            moving = { task, soFar };
          }
        : undefined;
      const result = await runner.run(command, {
        maxOutputBytes: BASH_OUTPUT_MAX_BYTES,
        keepTail: true,
        cwd: effectiveCwd,
        timeoutMs,
        // The turn's stop kills the command and what it started.
        signal: ctx.signal,
        ...(receive ? { detachAtTimeout: receive } : {})
      });
      if (result.stopped) throw new Error(TOOL_CALL_STOPPED);
      const handedOver = moving as { task: Promise<BackgroundTaskDto>; soFar: Buffer } | null;
      if (result.detached && handedOver) {
        // Refused, the command is killed. At the limit its agent is told so,
        // with its output so far; any other refusal is the call's error.
        let task: BackgroundTaskDto;
        try {
          task = await handedOver.task;
        } catch (err) {
          if (!(err instanceof CommandLimitReached)) throw err;
          return fitOutputSoFar({
            status: "stopped",
            movedAfterMs: timeoutMs,
            outputSoFar: tailOfOutput(handedOver.soFar, COMMAND_LIMITS).text,
            message: commandMoveRefusedMessage(timeoutMs, err.limit)
          });
        }
        return fitOutputSoFar({
          taskId: task.id,
          status: "running",
          outputPath: task.outputPath,
          movedAfterMs: timeoutMs,
          outputSoFar: tailOfOutput(handedOver.soFar, COMMAND_LIMITS).text,
          message: commandMovedMessage(task.id, task.outputPath ?? "", timeoutMs)
        });
      }
      return formatBashResult(result);
    }
  };
}

export const bashTool: ToolDefinition<BashArgs, BashResult> = createBashTool();

/** A moved command's result with as much of its output's end as leaves it
 *  within what the model is given inline, measured as the model gets it
 *  (escapes count): over it, the dispatcher would swap the result for a
 *  preview, and the task with it. The whole output is in the task's file.
 *  It keeps the newest output, from a line's start where there are lines,
 *  and never half a character. */
export function fitOutputSoFar(result: Extract<BashResult, { outputSoFar: string }>): Extract<BashResult, { outputSoFar: string }> {
  const whole = result.outputSoFar;
  // Starts are taken at whole characters: a probe on a pair's second half
  // is measured from its first, so what fits only shrinks as the start moves on.
  const charStart = (start: number) => {
    const code = whole.charCodeAt(start);
    return code >= 0xdc00 && code <= 0xdfff ? start - 1 : start;
  };
  const fits = (start: number) => JSON.stringify({ ...result, outputSoFar: whole.slice(charStart(start)) }).length <= MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS;
  if (fits(0)) return result;
  // The earliest start that fits: what is left only shrinks as it moves on.
  let low = 0;
  let high = whole.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) high = mid;
    else low = mid + 1;
  }
  let start = charStart(low);
  if (start > 0 && whole[start - 1] !== "\n") {
    const lineEnd = whole.indexOf("\n", start);
    if (lineEnd !== -1) start = lineEnd + 1;
  }
  return { ...result, outputSoFar: whole.slice(start) };
}

/** trimEnd, not `/\s+$/g`: that backtracks quadratically on a long run of
 *  whitespace that does not end the output (256KB of spaces before an "x"
 *  took about 22s). Both strip the same characters. */
export function formatBashResult(result: { stdout: string; stderr: string; exitCode: number }): string {
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  }
  if (result.stderr) {
    parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  }
  parts.push(`exitCode: ${result.exitCode}`);
  return parts.join("\n");
}
