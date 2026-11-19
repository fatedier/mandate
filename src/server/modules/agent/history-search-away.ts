import { errorText } from "../../../shared/error-text.js";
import type { SearchFound, SearchReads } from "./history-store.js";

/** The worker's path in the build: scripts/build-binary.ts makes it an
 *  entrypoint of the binary by this name. */
export const HISTORY_SEARCH_WORKER_ENTRY = "./src/server/modules/agent/history-search-worker.ts";

/** In a compiled binary an entrypoint is found by its path in the build (every
 *  module's import.meta.url there is the binary's own); from source, the
 *  worker sits beside this file. */
function workerSpec(): string {
  return import.meta.url.includes("/$bunfs/") ? HISTORY_SEARCH_WORKER_ENTRY : new URL("./history-search-worker.ts", import.meta.url).href;
}

type Answer = { ok: true; found: SearchFound } | { ok: false; message: string };

/**
 * A search's reads (runSearchReads) in a worker of its own, which opens the
 * database read-only beside the server's connection: a search over every
 * project's word matches reads thousands of rows, seconds when they are not
 * in memory, and on the server's thread that held every request, terminal
 * and agent. A worker per search; nothing outlives it.
 */
export function runSearchReadsAway(dbPath: string, reads: SearchReads): Promise<SearchFound> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSpec());
    worker.onmessage = (event: MessageEvent<Answer>) => {
      worker.terminate();
      const answer = event.data;
      if (answer.ok) resolve(answer.found);
      else reject(new Error(answer.message));
    };
    worker.onerror = (event: ErrorEvent) => {
      worker.terminate();
      reject(new Error(errorText(event.error ?? event.message)));
    };
    worker.postMessage({ dbPath, reads });
  });
}
