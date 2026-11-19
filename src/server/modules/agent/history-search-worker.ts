/**
 * Runs one chat history search's reads off the server's thread (see
 * runSearchReadsAway). A built entrypoint of its own (scripts/build-binary.ts).
 */
import { Database } from "bun:sqlite";
import { errorText } from "../../../shared/error-text.js";
import { runSearchReads, type SearchReads } from "./history-store.js";

declare const self: {
  onmessage: ((event: MessageEvent<{ dbPath: string; reads: SearchReads }>) => void) | null;
  postMessage(message: unknown): void;
};

self.onmessage = (event) => {
  try {
    // Read-only: this thread never writes, whatever a reader below would try.
    const db = new Database(event.data.dbPath, { readonly: true });
    try {
      self.postMessage({ ok: true, found: runSearchReads(db, event.data.reads) });
    } finally {
      db.close();
    }
  } catch (error) {
    self.postMessage({ ok: false, message: errorText(error) });
  }
};
