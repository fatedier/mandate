import { spawn } from "node:child_process";
import { logError } from "../logger.js";

/** What a command is run with: where, with what environment, how long it may
 *  take, and how much it may write. */
export interface CommandRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds; past it the child is sent `killSignal` and the run is a
   *  timeout. */
  timeout?: number;
  killSignal?: NodeJS.Signals | number;
  /** Bytes per stream; past it the child is stopped and the run is ENOBUFS. */
  maxBuffer?: number;
  encoding?: BufferEncoding;
}

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs a command without holding the server's one thread: it answers once
 *  the command has ended. Every git, tmux and helper command goes through
 *  one; tests give their own. */
export interface CommandRunner {
  run(command: string, args: string[], options?: CommandRunOptions): Promise<CommandResult>;
}

/** spawnSync's default, kept: a command that writes more fails alike. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** How long a stopped child's output is read after it exits: a descendant
 *  (a git helper) can hold the pipes open, and what came is what there is. */
const STOPPED_DRAIN_MS = 1000;
/** How long a stopped child may take to report its exit before it is killed
 *  outright and the call answers without it. */
const STOPPED_EXIT_WAIT_MS = 5_000;

/** A run over `spawn`, answering as spawnSync would have: an exit
 *  code is a status with no error; a timeout sends the caller's kill signal
 *  (SIGTERM by default) and, however the child then ends, is status null with
 *  an ETIMEDOUT error, logged with its command; a signal from elsewhere is
 *  status null and that signal; a stream past maxBuffer (bytes, each stream
 *  its own) stops the child the same way and is ENOBUFS, the read that
 *  crossed the limit kept; a spawn that failed (ENOENT) keeps its error. The
 *  signal reported is the one the child ended by, if any. Output is read to
 *  its end (a stopped child's last words included, for up to `drainMs` after
 *  it exits), then decoded in the caller's encoding. */
export function asyncCommandRunFrom(
  spawnChild: typeof spawn,
  tuning: { drainMs?: number; exitWaitMs?: number } = {}
): (command: string, args: string[], options?: CommandRunOptions) => Promise<CommandResult> {
  const drainMs = tuning.drainMs ?? STOPPED_DRAIN_MS;
  const exitWaitMs = tuning.exitWaitMs ?? STOPPED_EXIT_WAIT_MS;
  return (command, args, options = {}) => new Promise<CommandResult>((resolve) => {
    const encoding = options.encoding ?? "utf8";
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const killSignal = (options.killSignal ?? "SIGTERM") as NodeJS.Signals;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnChild(command, args, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      // Some launch failures (a cwd that is not a directory) are thrown here,
      // where spawnSync would have returned them.
      resolve({ status: null, signal: null, stdout: "", stderr: "", error: error as Error });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let overflowed = false;
    let timedOut = false;
    let stopped = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let draining = false;
    let spawnError: Error | null = null;
    let settled = false;
    // Stopped and exited, in either order: its output is read a short while
    // more, then what came is what there is.
    const drainSoon = () => {
      if (draining || !stopped || !exited) return;
      draining = true;
      const { code, signal } = exited;
      const late = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, drainMs);
      (late as { unref?: () => void }).unref?.();
    };
    const stop = () => {
      stopped = true;
      try { child.kill(killSignal); } catch { /* already gone */ }
      drainSoon();
      // A child whose exit is never reported (one that ignores the signal,
      // or an exit the runtime did not pass on: seen under heavy load) still
      // ends the call, killed outright: a call that never answers would hold
      // its request, and any turn it runs in, forever.
      const last = setTimeout(() => {
        if (exited) return;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, null);
      }, exitWaitMs);
      (last as { unref?: () => void }).unref?.();
    };
    const keep = (into: Buffer[]) => {
      let bytes = 0;
      return (chunk: Buffer | string) => {
        if (overflowed) return;
        const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        into.push(data);
        bytes += data.length;
        if (bytes > maxBuffer) {
          overflowed = true;
          stop();
        }
      };
    };
    child.stdout?.on("data", keep(out));
    child.stderr?.on("data", keep(err));
    const timer = options.timeout ? setTimeout(() => { timedOut = true; stop(); }, options.timeout) : null;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const text = { stdout: Buffer.concat(out).toString(encoding), stderr: Buffer.concat(err).toString(encoding) };
      if (spawnError) return resolve({ status: null, signal: null, ...text, error: spawnError });
      if (overflowed) {
        return resolve({ status: null, signal, ...text, error: Object.assign(new Error(`${command} ENOBUFS (stdout or stderr buffer reached maxBuffer)`), { code: "ENOBUFS" }) });
      }
      if (timedOut) {
        const error = Object.assign(new Error(`${command} ETIMEDOUT`), { code: "ETIMEDOUT" });
        logError(`command ${[command, ...args.slice(0, 2)].join(" ")}`, error);
        return resolve({ status: null, signal, ...text, error });
      }
      if (signal) return resolve({ status: null, signal, ...text });
      return resolve({ status: code, signal: null, ...text });
    };
    child.on("error", (error: Error) => { spawnError = error; finish(null, null); });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exited = { code, signal };
      drainSoon();
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));
  });
}

export const nodeCommandRunner: CommandRunner = { run: asyncCommandRunFrom(spawn) };

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

