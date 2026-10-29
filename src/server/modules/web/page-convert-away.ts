import { errorText } from "../../../shared/error-text.js";
import type { ConvertedPage } from "./page-convert.js";
import { PageError } from "./page-fetch.js";

type Answer = { ok: true; page: ConvertedPage } | { ok: false; message: string };

/** The worker's path in the build: scripts/build-binary.ts makes it an
 *  entrypoint of the binary by this name. */
export const PAGE_CONVERT_WORKER_ENTRY = "./src/server/modules/web/page-convert-worker.ts";

/** In a compiled binary an entrypoint is found by its path in the build (every
 *  module's import.meta.url there is the binary's own); from source, the
 *  worker sits beside this file. */
function workerSpec(): string {
  return import.meta.url.includes("/$bunfs/") ? PAGE_CONVERT_WORKER_ENTRY : new URL("./page-convert-worker.ts", import.meta.url).href;
}

/**
 * convertPage in a worker of its own, so a large page never holds the main
 * thread; a stop ends the worker at once and rejects with the stop's reason.
 * A worker per page: starting one and loading Defuddle in it costs about
 * 60 ms, little beside the read itself, and ending it is the only way to stop
 * a conversion part way.
 */
export function convertPageAway(
  input: { finalUrl: string; contentType: string; body: Uint8Array },
  signal?: AbortSignal
): Promise<ConvertedPage> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSpec());
    const end = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      end();
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<Answer>) => {
      end();
      const answer = event.data;
      if (answer.ok) resolve(answer.page);
      // A page that cannot be read says why, as one read on this thread would.
      else reject(new PageError(answer.message));
    };
    worker.onerror = (event: ErrorEvent) => {
      end();
      reject(new Error(errorText(event.error ?? event.message)));
    };
    worker.postMessage(input);
  });
}
