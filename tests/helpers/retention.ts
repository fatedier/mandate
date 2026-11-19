import type { Database } from "bun:sqlite";
import { DEFAULT_CONFIG } from "../../src/server/config/defaults.js";
import type { RetentionConfig } from "../../src/server/config/types.js";
import {
  applyRetentionWork,
  findRetentionWork,
  type RetentionPassResult,
  type RetentionWork
} from "../../src/server/platform/db/retention.js";

/** One retention pass as the server runs it, on one connection: what the
 *  worker finds, then what the server's connection does with it. */
export function runRetentionPass(
  db: Database,
  now: Date = new Date(),
  retention: RetentionConfig = DEFAULT_CONFIG.retention
): RetentionPassResult {
  return applyRetentionWork(db, findRetentionWork(db, now, retention), now);
}

/** What a pass would do, with the config's defaults. */
export function findDefaultRetentionWork(db: Database, now: Date = new Date()): RetentionWork {
  return findRetentionWork(db, now, DEFAULT_CONFIG.retention);
}
