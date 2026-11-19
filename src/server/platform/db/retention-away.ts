import type { RetentionConfig } from "../../config/types.js";
import { errorText } from "../../../shared/error-text.js";
import type { CeilingReading, RetentionWork } from "./retention.js";
import type { StaleToolOutputs } from "./tool-output-retention.js";
import { getLogLevel, logStacks, type LogLevel } from "../logger.js";

/** What one hourly pass looks for: the chat and call retention's work, then
 *  the tool output files to remove. */
export interface RetentionRequest {
  /** The database file; the worker opens a connection of its own to it. */
  dbPath: string;
  nowMs: number;
  retention: RetentionConfig;
  /** The last measure of the chat table, carried from the pass before. */
  ceiling: CeilingReading | null;
  dataDir: string;
  /** Output files of running commands: kept. */
  runningPaths: string[];
}

/** A request as the worker gets it: with this thread's logging. */
export type RetentionWorkerMessage = RetentionRequest & { logging: { level: LogLevel; stacks: boolean } };

/** What the pass found, each part on its own, as each failed on its own
 *  before; the server's connection does it (applyRetentionWork,
 *  removeToolOutputs). */
export interface RetentionOutcome {
  work: RetentionWork | { error: string };
  toolOutputs: StaleToolOutputs | { error: string };
  ceiling: CeilingReading | null;
}

/** The worker's path in the build: scripts/build-binary.ts makes it an
 *  entrypoint of the binary by this name. */
export const RETENTION_WORKER_ENTRY = "./src/server/platform/db/retention-worker.ts";

/** In a compiled binary an entrypoint is found by its path in the build (every
 *  module's import.meta.url there is the binary's own); from source, the
 *  worker sits beside this file. */
function workerSpec(): string {
  return import.meta.url.includes("/$bunfs/") ? RETENTION_WORKER_ENTRY : new URL("./retention-worker.ts", import.meta.url).href;
}

/**
 * Finds one retention pass's work in a worker of its own: finding it scans
 * the chat table, seconds once it is large, and on the main thread that held
 * every request, terminal and agent. The worker opens the database read-only
 * and writes nothing, not a file either: a second writer would fail a
 * transaction of the server's that read before the write landed, and a walk
 * that removed files itself could not see a thread or command started while
 * it ran. The server does the work, asking again of each row and file.
 * `stop` ends the worker at shutdown.
 */
export function runRetentionAway(request: RetentionRequest): { done: Promise<RetentionOutcome>; stop(): void } {
  const worker = new Worker(workerSpec());
  let settle: ((outcome: RetentionOutcome | Error) => void) | null = null;
  const done = new Promise<RetentionOutcome>((resolve, reject) => {
    settle = (outcome) => {
      settle = null;
      worker.terminate();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
  });
  worker.onmessage = (event: MessageEvent<RetentionOutcome>) => settle?.(event.data);
  worker.onerror = (event: ErrorEvent) => settle?.(new Error(errorText(event.error ?? event.message)));
  // Its logger is told this thread's settings (config.json's, or the flag's).
  worker.postMessage({ ...request, logging: { level: getLogLevel(), stacks: logStacks() } } satisfies RetentionWorkerMessage);
  return { done, stop: () => settle?.(new Error("retention pass stopped")) };
}
