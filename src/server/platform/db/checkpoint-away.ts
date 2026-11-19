import type { Database } from "bun:sqlite";
import { logError } from "../logger.js";

/** The worker's path in the build: scripts/build-binary.ts makes it an
 *  entrypoint of the binary by this name. */
export const CHECKPOINT_WORKER_ENTRY = "./src/server/platform/db/checkpoint-worker.ts";

/** Intervals without a word from the worker before the server's connection
 *  checkpoints again itself. */
const SILENT_INTERVALS = 3;
/** SQLite's own threshold, put back whenever the worker cannot do the work. */
const SQLITE_AUTO_CHECKPOINT_PAGES = 1000;

/** What the worker says: each checkpoint's result, or why it could not. */
export type CheckpointMessage =
  | { ok: true; busy: number; log: number; checkpointed: number }
  | { ok: false; message: string };

/** The part of a Worker used here (tests pass their own). */
export interface CheckpointWorker {
  onmessage: ((event: MessageEvent<CheckpointMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

/** In a compiled binary an entrypoint is found by its path in the build
 *  (every module's import.meta.url there is the binary's own); from source,
 *  the worker sits beside this file. */
function workerSpec(): string {
  return import.meta.url.includes("/$bunfs/") ? CHECKPOINT_WORKER_ENTRY : new URL("./checkpoint-worker.ts", import.meta.url).href;
}

/**
 * Moves WAL checkpoints off the server's thread. SQLite checkpoints when the
 * log reaches 1000 pages, on the thread whose COMMIT crossed it: here the
 * server's only thread, which waits for the copy and its sync (tens of
 * milliseconds, and hundreds under a busy disk). SQLite's documented alternative is to turn
 * the automatic checkpoint off and run checkpoints from another thread
 * (sqlite.org/wal.html, 2.3). A worker with a connection of its own runs
 * PASSIVE checkpoints, which never wait for a reader or the writer.
 *
 * The server's connection stops checkpointing only once the worker has run
 * one, and checkpoints itself again if the worker fails, falls silent, or is
 * stopped: the log never grows without a checkpointer.
 */
export function startBackgroundCheckpoints(db: Database, options: {
  intervalMs: number;
  spawn?: () => CheckpointWorker;
}): { stop(): void } {
  const intervalMs = options.intervalMs;
  const worker = options.spawn ? options.spawn() : (new Worker(workerSpec()) as unknown as CheckpointWorker);
  let handedOver = false;
  let ended = false;
  let lastWord = Date.now();

  const takeBack = (why: string | null) => {
    if (ended) return;
    ended = true;
    clearInterval(watchdog);
    if (handedOver) db.exec(`pragma wal_autocheckpoint = ${SQLITE_AUTO_CHECKPOINT_PAGES}`);
    handedOver = false;
    // Asked to close its connection; ended anyway soon after.
    try { worker.postMessage({ stop: true }); } catch { /* already gone */ }
    setTimeout(() => worker.terminate(), 1000).unref?.();
    if (why) logError("checkpoints", new Error(why), "background checkpoints stopped; SQLite checkpoints on the server's connection again");
  };

  worker.onmessage = (event) => {
    if (ended) return;
    const said = event.data;
    if (!said.ok) {
      takeBack(said.message);
      worker.terminate();
      return;
    }
    lastWord = Date.now();
    if (!handedOver) {
      db.exec("pragma wal_autocheckpoint = 0");
      handedOver = true;
      console.log(`[mandate] checkpoints: run off the main thread every ${Math.round(intervalMs / 1000)}s`);
    }
  };
  worker.onerror = (event) => {
    takeBack(event.message || "the checkpoint worker failed");
    worker.terminate();
  };
  const watchdog = setInterval(() => {
    if (Date.now() - lastWord <= SILENT_INTERVALS * intervalMs) return;
    takeBack(`no checkpoint for ${Math.round((Date.now() - lastWord) / 1000)} s`);
    worker.terminate();
  }, intervalMs);
  watchdog.unref?.();

  worker.postMessage({ dbPath: db.filename, intervalMs });
  return { stop: () => takeBack(null) };
}
