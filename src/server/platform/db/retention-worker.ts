/**
 * Finds one hourly retention pass's work off the server's main thread (see
 * runRetentionAway): its scans of the chat table take seconds once the table
 * is large. Reads only. A built entrypoint of its own (scripts/build-binary.ts).
 */
import { Database } from "bun:sqlite";
import { errorText } from "../../../shared/error-text.js";
import { ceilingReading, findRetentionWork, rememberCeilingReading } from "./retention.js";
import { setLogLevel, setLogStacks } from "../logger.js";
import type { RetentionOutcome, RetentionWorkerMessage } from "./retention-away.js";
import { findStaleToolOutputs } from "./tool-output-retention.js";

declare const self: {
  onmessage: ((event: MessageEvent<RetentionWorkerMessage>) => void) | null;
  postMessage(message: RetentionOutcome): void;
};

self.onmessage = (event) => {
  const request = event.data;
  setLogLevel(request.logging.level);
  setLogStacks(request.logging.stacks);
  const now = new Date(request.nowMs);
  let db: Database;
  try {
    db = new Database(request.dbPath, { readonly: true });
  } catch (error) {
    const failed = { error: errorText(error) };
    self.postMessage({ work: failed, toolOutputs: failed, ceiling: request.ceiling });
    return;
  }
  try {
    if (request.ceiling) rememberCeilingReading(db, request.ceiling);
    let work: RetentionOutcome["work"];
    try {
      work = findRetentionWork(db, now, request.retention);
    } catch (error) {
      work = { error: errorText(error) };
    }
    let toolOutputs: RetentionOutcome["toolOutputs"];
    try {
      toolOutputs = findStaleToolOutputs({ db, dataDir: request.dataDir, now, runningPaths: request.runningPaths });
    } catch (error) {
      toolOutputs = { error: errorText(error) };
    }
    self.postMessage({ work, toolOutputs, ceiling: ceilingReading(db) ?? request.ceiling });
  } finally {
    db.close();
  }
};
