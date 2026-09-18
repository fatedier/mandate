/** Exit with the parent. The desktop shell spawns `mandate serve` as a
 *  sidecar and kills it on quit, but a shell that crashes, is force-quit or
 *  dies with a logout never gets to — the server then outlives it, holding
 *  the port and the data dir (eight such orphans were found on one machine
 *  on 2026-09-18). With `--parent-pid`, the server polls the given process
 *  and shuts itself down once it is gone.
 *
 *  A pid poll rather than stdin EOF: it does not depend on how the parent
 *  wired the pipes, and it works the same under a debugger or a wrapper. */

export const PARENT_WATCH_INTERVAL_MS = 2000;

export type ParentWatchOptions = {
  pid: number;
  /** Whether a process with this pid exists. Defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Called once, when the parent is first seen gone. */
  onGone: () => void;
  intervalMs?: number;
  /** Timer hooks for tests. */
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
};

/** True while the process exists (EPERM means it exists but is not ours). */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Starts polling; returns a stop function. Fires `onGone` at most once, and
 *  immediately if the parent is already gone at start. */
export function watchParent(opts: ParentWatchOptions): () => void {
  const isAlive = opts.isAlive ?? processExists;
  const set = opts.setInterval ?? globalThis.setInterval;
  const clear = opts.clearInterval ?? globalThis.clearInterval;
  let done = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const check = () => {
    if (done) return;
    if (isAlive(opts.pid)) return;
    done = true;
    if (timer !== null) clear(timer);
    timer = null;
    opts.onGone();
  };
  check();
  if (!done) {
    timer = set(check, opts.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
    // Never keep the process alive just to watch its parent.
    (timer as { unref?: () => void }).unref?.();
  }
  return () => {
    done = true;
    if (timer !== null) clear(timer);
    timer = null;
  };
}

/** `--parent-pid` value → pid, or an error message for the CLI. */
export function parseParentPid(value: string | undefined): { pid: number } | { error: string } | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || Number(value) <= 0) return { error: `--parent-pid must be a positive integer, got "${value}"` };
  return { pid: Number(value) };
}
