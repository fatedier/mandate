import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { logError } from "../logger.js";

export type CommandRunOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & {
  encoding?: BufferEncoding;
};

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandRunOptions): CommandResult;
}

/** A runner over a `spawnSync`. A spawn that carries an error did not
 *  finish, whatever status it reports: Bun 1.4.2 can lose a child's exit,
 *  spin until the timeout, and then return status 0 with no output
 *  (oven-sh/bun#34069). Callers decide on `status`, so that is a failure here,
 *  and a timeout is logged with its command. */
export function commandRunnerFrom(spawn: typeof spawnSync): CommandRunner {
  return {
    run(command, args, options = {}) {
      const result = spawn(command, args, {
        encoding: "utf8",
        ...options
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        logError(`command ${[command, ...args.slice(0, 2)].join(" ")}`, result.error);
      }
      return {
        status: result.error ? null : result.status,
        signal: result.signal,
        stdout: String(result.stdout || ""),
        stderr: String(result.stderr || ""),
        error: result.error
      };
    }
  };
}

export const nodeCommandRunner: CommandRunner = commandRunnerFrom(spawnSync);

/** The command did not answer: it timed out or was killed by a signal. Not
 *  the same as answering "no", and not a missing binary (ENOENT), which is a
 *  definite no. */
export function commandDidNotAnswer(r: CommandResult): boolean {
  return r.status === null && ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal !== null);
}

/** Thrown where an unanswered command would otherwise read as "no": acting on
 *  that no opens a second window, splits an extra pane, registers a project
 *  without its workers. Over HTTP it is a 503 the user can retry. */
export class CommandDidNotAnswerError extends Error {
  constructor(what: string) {
    super(`${what} did not answer in time. Try again.`);
    this.name = "CommandDidNotAnswerError";
  }
}

export function commandFailureMessage(result: CommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || result.error?.message || fallback;
}

