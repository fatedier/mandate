/**
 * Converts one page off the server's main thread (see convertPageAway):
 * Defuddle on a large page runs for seconds without yielding, and on the main
 * thread that would hold up every agent, the UI's live updates and a stop.
 * A built entrypoint of its own (scripts/build-binary.ts).
 */
import { errorText } from "../../../shared/error-text.js";
import { convertPage } from "./page-convert.js";

// Converting a page asks nothing of the network (Defuddle runs with
// `useAsync: false`); here that holds whatever a library would try.
globalThis.fetch = (() => Promise.reject(new Error("page conversion makes no requests"))) as unknown as typeof fetch;

declare const self: {
  onmessage: ((event: MessageEvent<Parameters<typeof convertPage>[0]>) => void) | null;
  postMessage(message: unknown): void;
};

self.onmessage = (event) => {
  convertPage(event.data).then(
    (page) => self.postMessage({ ok: true, page }),
    (error: unknown) => self.postMessage({ ok: false, message: errorText(error) })
  );
};
