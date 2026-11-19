/**
 * Checkpoints the server's WAL database on a thread of its own (see
 * startBackgroundCheckpoints). Its connection only checkpoints: PASSIVE copies
 * what it can of the log into the database file without waiting for a
 * reader or the writer, and changes no row, so no transaction of the
 * server's is affected. A built entrypoint of its own (scripts/build-binary.ts).
 */
import { Database } from "bun:sqlite";
import { errorText } from "../../../shared/error-text.js";

declare const self: {
  onmessage: ((event: MessageEvent<{ dbPath: string; intervalMs: number } | { stop: true }>) => void) | null;
  postMessage(message: unknown): void;
};

let db: Database | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const checkpoint = () => {
  if (!db) return;
  try {
    const result = db.prepare("pragma wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
    self.postMessage({ ok: true, ...result });
  } catch (error) {
    self.postMessage({ ok: false, message: errorText(error) });
  }
};

self.onmessage = (event) => {
  const message = event.data;
  if ("stop" in message) {
    if (timer) clearInterval(timer);
    timer = null;
    db?.close();
    db = null;
    return;
  }
  try {
    db = new Database(message.dbPath);
    // The server's writes come first: a checkpoint never makes one wait long.
    db.exec("pragma busy_timeout = 1000");
  } catch (error) {
    self.postMessage({ ok: false, message: errorText(error) });
    return;
  }
  checkpoint();
  timer = setInterval(checkpoint, message.intervalMs);
};
