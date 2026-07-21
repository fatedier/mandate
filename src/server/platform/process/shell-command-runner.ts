import { spawn } from "node:child_process";
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

interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ShellCommandRunOptions {
  cwd: string;
  timeoutMs: number;
  shellPath?: string;
}

export interface ShellCommandRunner {
  run(command: string, options: ShellCommandRunOptions): Promise<ShellCommandResult>;
}

export interface ShellCommandRunnerOptions {
  /** Shell whose environment is snapshotted and used to run commands. */
  shell?: UserShell;
  /** Shell used to run commands when the snapshot capture fails. */
  fallbackShell?: UserShell;
  /** Directory the snapshot file is written into. */
  snapshotDir?: string;
  /** Environment for the snapshot capture (defaults to the server's env). */
  captureEnv?: Record<string, string>;
}

interface SnapshotState {
  shell: UserShell;
  snapshotPath: string | null;
}

/** How long a killed process gets to die before SIGKILL, then before the
 *  call force-settles even if 'close' never fires (pipes held open). */
const KILL_ESCALATION_MS = 2000;
const FORCE_SETTLE_MS = 1000;

export function createShellCommandRunner(opts: ShellCommandRunnerOptions = {}): ShellCommandRunner {
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

  return {
    async run(command, options) {
      if (options.shellPath) {
        return spawnCommand([options.shellPath, "-lc", command], options);
      }
      const state = await init();
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
      const argv = snapshotPath
        ? wrapWithSnapshot(command, state.shell, snapshotPath)
        : wrapLoginFallback(command, state.shell);
      return spawnCommand(argv, options);
    }
  };
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    // Negative pid: the whole process group (the child is a group leader via
    // detached), so backgrounded grandchildren die with it.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function spawnCommand(argv: string[], options: ShellCommandRunOptions): Promise<ShellCommandResult> {
  return new Promise<ShellCommandResult>((resolve) => {
    const [executable = "/bin/bash", ...args] = argv;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: true
    });
    // No interactive input: stdin-readers should see EOF, not block.
    child.stdin?.end();
    // Decode once at the end — per-chunk toString corrupts multibyte
    // characters split across pipe-chunk boundaries.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        stderr += `\n[bash: command timed out after ${options.timeoutMs}ms]`;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
        exitCode
      });
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, "SIGTERM");
        timers.push(
          setTimeout(() => {
            killGroup(child.pid, "SIGKILL");
            // A grandchild in another group can still hold the pipes open;
            // settle regardless once the group has been SIGKILLed.
            timers.push(setTimeout(() => finish(-1), FORCE_SETTLE_MS));
          }, KILL_ESCALATION_MS)
        );
      }, options.timeoutMs)
    );
    child.stdout?.on("data", (b: Buffer) => {
      stdoutChunks.push(b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderrChunks.push(b);
    });
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "ENOENT" ? `bash executable not available: ${err.message}` : err.message;
      stderrChunks.push(Buffer.from(msg, "utf8"));
      finish(-1);
    });
  });
}

export const nodeShellCommandRunner: ShellCommandRunner = createShellCommandRunner();
