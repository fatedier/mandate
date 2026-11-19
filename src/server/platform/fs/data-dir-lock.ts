import { dlopen, FFIType, read } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";

/** The file in a data directory that one server at a time holds. */
export const DATA_DIR_LOCK_FILE = "server.lock";

/** How long a starting server waits for the directory: a desktop restart
 *  starts the next server as soon as the last one's port closes, which can
 *  be a moment before its lock goes. */
const WAIT_MS = 3000;
const POLL_MS = 100;

export interface DataDirLock {
  /** False when this system could not lock the file (a filesystem without
   *  locks, a platform without flock): the server runs, unguarded. */
  guarded: boolean;
  /** Why it is not guarded. */
  reason?: string;
  /** Lets the directory go. A server never calls it: its lock goes with its
   *  process, however that ends. */
  release(): void;
}

/** flock(2), with the errno of a failed call. */
interface Flock {
  lock(fd: number): number;
  errno(): number;
  /** The errno that says another holds it. */
  wouldBlock: number;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const EINTR = 4;

let flock: Flock | null | undefined;

function systemFlock(): Flock | null {
  if (flock !== undefined) return flock;
  try {
    if (process.platform === "darwin") {
      const lib = dlopen("/usr/lib/libSystem.B.dylib", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        __error: { args: [], returns: FFIType.ptr }
      });
      flock = { lock: (fd) => lib.symbols.flock(fd, LOCK_EX | LOCK_NB), errno: () => read.i32(lib.symbols.__error()!, 0), wouldBlock: 35 };
    } else if (process.platform === "linux") {
      const lib = dlopen("libc.so.6", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        __errno_location: { args: [], returns: FFIType.ptr }
      });
      flock = { lock: (fd) => lib.symbols.flock(fd, LOCK_EX | LOCK_NB), errno: () => read.i32(lib.symbols.__errno_location()!, 0), wouldBlock: 11 };
    } else {
      flock = null;
    }
  } catch {
    flock = null;
  }
  return flock;
}

/** Open for as long as the process lives. */
const held = new Set<number>();

/**
 * One server per data directory. The lock is flock(2) on a file of its own in
 * the directory, kept for the life of the process: the operating system lets
 * it go when the process ends in any way, a crash or kill -9 included, so
 * nothing is left to clean up. flock belongs to the open file, not to the
 * process, so the server opening and closing the same file elsewhere (an
 * agent reading it) leaves it held, where a POSIX record lock would go. On a
 * network filesystem the lock may not hold.
 *
 * Null when another process still holds the directory after `waitMs`.
 */
export async function lockDataDir(
  dir: string,
  options: { waitMs?: number; pollMs?: number } = {}
): Promise<DataDirLock | null> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, DATA_DIR_LOCK_FILE);
  const system = systemFlock();
  if (!system) return unguarded(`flock is not available on ${process.platform}`);
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  for (;;) {
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    let result = system.lock(fd);
    let errno = result === 0 ? 0 : system.errno();
    while (result !== 0 && errno === EINTR) {
      result = system.lock(fd);
      errno = result === 0 ? 0 : system.errno();
    }
    if (result === 0) {
      held.add(fd);
      return {
        guarded: true,
        release: () => {
          if (held.delete(fd)) fs.closeSync(fd);
        }
      };
    }
    fs.closeSync(fd);
    if (errno !== system.wouldBlock) return unguarded(`flock failed with errno ${errno}`);
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS));
  }
}

function unguarded(reason: string): DataDirLock {
  return { guarded: false, reason, release: () => {} };
}
