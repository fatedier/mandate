import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { logError } from "../logger.js";
import { resolveDataDir } from "../fs/data-dir.js";
import {
  captureShellSnapshot,
  detectUserShell,
  wrapLoginFallback,
  wrapWithSnapshot,
  type UserShell
} from "./shell-snapshot.js";
import { HeadTailBuffer } from "./head-tail-buffer.js";

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Killed for running past timeoutMs (stderr also says so). */
  timedOut: boolean;
  /** Killed because `signal` aborted (or never started: it had already). */
  stopped?: boolean;
  /** Handed over at its timeout (detachAtTimeout), still running; stdout and
   *  stderr hold what came before. */
  detached?: boolean;
}

/** How a process ended: its exit code, or the signal that ended it. */
export interface ShellProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A running command whose keeper is not a call: a background command. */
export interface ShellProcess {
  pid: number | null;
  /** Each chunk of stdout and stderr, in the order they arrive. What came
   *  before the first listener is held for it. */
  onOutput(listener: (chunk: Buffer) => void): void;
  /** Settles once: when its output closes, or forceSettleMs after the
   *  SIGKILL of a kill when a grandchild holds the pipes. */
  exited: Promise<ShellProcessExit>;
  /** SIGTERM to the group, SIGKILL after escalationMs (sent even after
   *  exited settles, to the group only). */
  kill(): void;
}

export interface ShellCommandRunOptions {
  cwd: string;
  timeoutMs: number;
  shellPath?: string;
  /** Keep at most this many bytes of each stream while the command runs; the
   *  rest is read and dropped, so output cannot grow memory without bound.
   *  Unset keeps everything. */
  maxOutputBytes?: number;
  /** With maxOutputBytes: keep the first half and the last half, with a
   *  `... N bytes omitted ...` line between them. Without it, the first
   *  maxOutputBytes and nothing more. */
  keepTail?: boolean;
  /** Stops the command when it aborts: the whole group is killed, as at a
   *  timeout. Already aborted, nothing is started. */
  signal?: AbortSignal;
  /** At the timeout, hand the still-running process over instead of killing
   *  it, with both streams' output so far in the order it came (its first and
   *  last SO_FAR_MAX_BYTES / 2 past that); the result then has `detached`.
   *  From then on the process is the receiver's: `signal` no longer stops it. */
  detachAtTimeout?: (process: ShellProcess, soFar: Buffer) => void;
}

export interface ShellCommandRunner {
  run(command: string, options: ShellCommandRunOptions): Promise<ShellCommandResult>;
  /** Starts a command and hands it over running. Null when `signal` stopped
   *  it before it started. */
  spawn(command: string, options: { cwd: string; signal?: AbortSignal }): Promise<ShellProcess | null>;
}

interface ShellCommandRunnerOptions {
  /** Shell whose environment is snapshotted and used to run commands. */
  shell?: UserShell;
  /** Shell used to run commands when the snapshot capture fails. */
  fallbackShell?: UserShell;
  /** Directory the snapshot file is written into. */
  snapshotDir?: string;
  /** Environment for the snapshot capture (defaults to the server's env). */
  captureEnv?: Record<string, string>;
  /** How long a killed process gets to die (DEFAULT_KILL_TIMINGS unless set). */
  killTimings?: KillTimings;
}

interface SnapshotState {
  shell: UserShell;
  snapshotPath: string | null;
}

/** How long a killed process gets to die before SIGKILL (escalationMs), then
 *  before the call force-settles even if 'close' never fires, pipes held
 *  open (forceSettleMs). */
export interface KillTimings {
  escalationMs: number;
  forceSettleMs: number;
}
const DEFAULT_KILL_TIMINGS: KillTimings = { escalationMs: 2000, forceSettleMs: 1000 };

/** What a call moved at its timeout hands over of its output so far. */
const SO_FAR_MAX_BYTES = 1024 * 1024;

export function createShellCommandRunner(opts: ShellCommandRunnerOptions = {}): ShellCommandRunner {
  const timings = opts.killTimings ?? DEFAULT_KILL_TIMINGS;
  let statePromise: Promise<SnapshotState> | null = null;
  let warnedMissingSnapshot = false;

  const init = (): Promise<SnapshotState> => {
    statePromise ??= (async () => {
      const shell = opts.shell ?? detectUserShell();
      const snapshotDir = opts.snapshotDir ?? path.join(resolveDataDir(), "shell-snapshots");
      const snapshotPath = await captureShellSnapshot({
        shell,
        outPath: path.join(snapshotDir, `snapshot-${shell.type}.sh`),
        env: opts.captureEnv
      }).catch((err) => {
        logError("shell-snapshot", err, "snapshot capture threw");
        return null;
      });
      if (snapshotPath) return { shell, snapshotPath };
      logError(
        "shell-snapshot",
        new Error(
          `login-env snapshot unavailable for ${shell.path}; bash commands fall back to a plain login shell`
        )
      );
      return { shell: opts.fallbackShell ?? shell, snapshotPath: null };
    })();
    return statePromise;
  };

  /** The shell's argv for a command, or null when `signal` stopped it first. */
  const argvFor = async (command: string, signal: AbortSignal | undefined): Promise<string[] | null> => {
    // The login environment is read once, on first use: a call stopped
    // before it began starts no read, and one stopped meanwhile does not
    // wait for it (the read goes on for the calls after).
    if (signal?.aborted) return null;
    const state = await untilAborted(init(), signal);
    if (!state) return null;
    // Re-check per call: a snapshot deleted mid-lifetime must degrade to
    // the login-shell fallback, not silently source a dead path.
    let snapshotPath = state.snapshotPath;
    if (snapshotPath && !existsSync(snapshotPath)) {
      if (!warnedMissingSnapshot) {
        warnedMissingSnapshot = true;
        logError(
          "shell-snapshot",
          new Error(`snapshot file disappeared (${snapshotPath}); using login-shell fallback`)
        );
      }
      snapshotPath = null;
    }
    return snapshotPath
      ? wrapWithSnapshot(command, state.shell, snapshotPath)
      : wrapLoginFallback(command, state.shell);
  };

  return {
    async run(command, options) {
      if (options.shellPath) {
        return spawnCommand([options.shellPath, "-lc", command], options, timings);
      }
      const argv = await argvFor(command, options.signal);
      return argv ? spawnCommand(argv, options, timings) : { ...STOPPED_BEFORE_START };
    },

    async spawn(command, options) {
      const argv = await argvFor(command, options.signal);
      if (!argv || options.signal?.aborted) return null;
      return launch(argv, options.cwd, timings);
    }
  };
}

/** A call stopped before its command started. */
const STOPPED_BEFORE_START: ShellCommandResult = { stdout: "", stderr: "", exitCode: -1, timedOut: false, stopped: true };

/** `promise`'s value, or null once `signal` aborts first (or had already). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener("abort", onAbort); reject(err); }
    );
  });
}

/** `groupOnly`: never the pid alone (the call has settled: the pid may be
 *  another process's by then, while a group outlives its leader). */
function killGroup(pid: number | undefined, signal: NodeJS.Signals, groupOnly = false): void {
  if (!pid) return;
  try {
    // Negative pid: the whole process group (the child is a group leader via
    // detached), so backgrounded grandchildren die with it.
    process.kill(-pid, signal);
  } catch {
    if (groupOnly) return;
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Where a stream's bytes go: all of them, or with a cap what HeadTailBuffer
 *  keeps. Decoded once at the end — per-chunk toString corrupts multibyte
 *  characters split across pipe-chunk boundaries. */
function streamCollector(options: ShellCommandRunOptions): { push(chunk: Buffer): void; toString(): string } {
  if (options.maxOutputBytes !== undefined) return new HeadTailBuffer(options.maxOutputBytes, { keepTail: options.keepTail ?? false });
  const chunks: Buffer[] = [];
  return {
    push: (chunk) => { chunks.push(chunk); },
    toString: () => Buffer.concat(chunks).toString("utf8")
  };
}

/** A child as a handle someone keeps: its output to whoever listens (held
 *  until the first listener), its end once, and a kill of its group. Fed the
 *  child's events by whoever holds them. `exit`: an exit already seen. */
function processHandle(pid: number | undefined, exitSeen: ShellProcessExit | null, timings: KillTimings) {
  const listeners: Array<(chunk: Buffer) => void> = [];
  const held: Buffer[] = [];
  let exit = exitSeen;
  let settled = false;
  let killing = false;
  let resolveExit!: (value: ShellProcessExit) => void;
  const exited = new Promise<ShellProcessExit>((resolve) => { resolveExit = resolve; });
  const settle = (value: ShellProcessExit) => {
    if (settled) return;
    settled = true;
    resolveExit(value);
  };
  const handle: ShellProcess = {
    pid: pid ?? null,
    onOutput: (listener) => {
      listeners.push(listener);
      for (const chunk of held.splice(0)) listener(chunk);
    },
    exited,
    // As a call's kill: SIGTERM, then the SIGKILL even once it has settled,
    // then settled regardless, with the command's own exit when it had one.
    // Once the shell has exited, to the group only: a kept process can be
    // killed hours later, when its pid may be another process's.
    kill: () => {
      if (killing) return;
      killing = true;
      killGroup(pid, "SIGTERM", settled || exit !== null);
      setTimeout(() => {
        killGroup(pid, "SIGKILL", settled || exit !== null);
        if (!settled) setTimeout(() => settle(exit ?? { code: null, signal: "SIGKILL" }), timings.forceSettleMs).unref();
      }, timings.escalationMs).unref();
    }
  };
  return {
    process: handle,
    output: (chunk: Buffer) => {
      if (listeners.length === 0) held.push(chunk);
      else for (const listener of listeners) listener(chunk);
    },
    exit: (value: ShellProcessExit) => { exit = value; },
    close: (value: ShellProcessExit) => settle(exit ?? value),
    error: () => settle(exit ?? { code: -1, signal: null })
  };
}

/** Feeds a handle the child's events. Out here, so the listeners hold the
 *  child and the handle only, never a moved call's scope. */
function wireHandle(child: ChildProcess, handle: ReturnType<typeof processHandle>): void {
  child.stdout?.on("data", handle.output);
  child.stderr?.on("data", handle.output);
  child.on("exit", (code, signal) => handle.exit({ code, signal }));
  child.on("close", (code, signal) => handle.close({ code, signal }));
  child.on("error", (err) => {
    logError("shell-runner", err, "a background command's process failed");
    handle.error();
  });
}

/** A command started for a keeper (spawn): no timeout, no cap, no input. */
function launch(argv: string[], cwd: string, timings: KillTimings): ShellProcess {
  const [executable = "/bin/bash", ...args] = argv;
  const child: ChildProcess = spawn(executable, args, { cwd, detached: true });
  child.stdin?.end();
  const handle = processHandle(child.pid, null, timings);
  wireHandle(child, handle);
  return handle.process;
}

function spawnCommand(argv: string[], options: ShellCommandRunOptions, timings: KillTimings): Promise<ShellCommandResult> {
  return new Promise<ShellCommandResult>((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ...STOPPED_BEFORE_START });
      return;
    }
    const [executable = "/bin/bash", ...args] = argv;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: true
    });
    // No interactive input: stdin-readers should see EOF, not block.
    child.stdin?.end();
    const stdout = streamCollector(options);
    const stderr = streamCollector(options);
    // The runner's own words, outside the cap: a spawn failure says why.
    let spawnError: string | null = null;
    let timedOut = false;
    let stopped = false;
    let exited = false;
    let exitStatus = -1;
    let exitSeen: ShellProcessExit | null = null;
    let killing = false;
    const soFar = options.detachAtTimeout ? new HeadTailBuffer(SO_FAR_MAX_BYTES, { keepTail: true }) : null;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // The group gets SIGTERM, then SIGKILL. The SIGKILL goes out even when
    // the call has settled by then: a member that ignores SIGTERM and holds
    // none of the output outlives the shell. A grandchild in another group
    // can still hold the pipes open, so the call settles regardless after
    // that, with the command's own exit when it had one.
    const kill = () => {
      if (killing) return;
      killing = true;
      killGroup(child.pid, "SIGTERM", exited);
      setTimeout(() => {
        killGroup(child.pid, "SIGKILL", settled || exited);
        if (!settled) timers.push(setTimeout(() => finish(exited ? exitStatus : -1), timings.forceSettleMs));
      }, timings.escalationMs).unref();
    };
    // A command that has ended by itself is not stopped, though what it left
    // in the background may still hold its output open: that is killed.
    const onAbort = () => {
      if (settled || killing) return;
      if (!exited) stopped = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      options.signal?.removeEventListener("abort", onAbort);
      let stderrText = stderr.toString();
      if (spawnError) stderrText += `${stderrText ? "\n" : ""}${spawnError}`;
      if (timedOut) {
        stderrText += `\n[bash: command timed out after ${options.timeoutMs}ms]`;
      }
      resolve({
        stdout: stdout.toString(),
        stderr: stderrText,
        exitCode,
        timedOut,
        stopped
      });
    };
    // The call settles detached, and the child, still running, goes to
    // whoever asked for it; nothing kills it here. Its events become the
    // handle's alone, so nothing of the call (what it collected) stays held.
    const detach = (receive: NonNullable<ShellCommandRunOptions["detachAtTimeout"]>) => {
      settled = true;
      for (const t of timers) clearTimeout(t);
      options.signal?.removeEventListener("abort", onAbort);
      const handed = processHandle(child.pid, exitSeen, timings);
      const output = soFar!.bytes();
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      wireHandle(child, handed);
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: -1, timedOut: false, stopped: false, detached: true });
      try {
        receive(handed.process, output);
      } catch (err) {
        logError("shell-runner", err, "the receiver of a moved command threw; it is killed");
        handed.process.kill();
      }
    };
    timers.push(
      setTimeout(() => {
        if (killing || settled) return;
        // A shell that has exited is not still running: what it left behind
        // only holds its output (`cmd & check`). It is killed as before,
        // never moved to run on without end.
        if (options.detachAtTimeout && !exited) {
          detach(options.detachAtTimeout);
          return;
        }
        timedOut = true;
        kill();
      }, options.timeoutMs)
    );
    const onStdout = (b: Buffer) => { stdout.push(b); soFar?.push(b); };
    const onStderr = (b: Buffer) => { stderr.push(b); soFar?.push(b); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      exitStatus = code ?? -1;
      exitSeen = { code, signal };
    };
    const onClose = (code: number | null) => finish(code ?? -1);
    const onError = (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "ENOENT" ? `bash executable not available: ${err.message}` : err.message;
      spawnError = msg;
      finish(-1);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("exit", onExit);
    child.on("close", onClose);
    child.on("error", onError);
  });
}

export const nodeShellCommandRunner: ShellCommandRunner = createShellCommandRunner();
