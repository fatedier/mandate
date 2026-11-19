/**
 * One retention pass in a process of its own, this thread's log level given
 * by the command line (dbPath dataDir level): what its worker prints goes to
 * this process's stderr, which the test reads.
 */
import { runRetentionAway } from "../../src/server/platform/db/retention-away.js";
import { setLogLevel } from "../../src/server/platform/logger.js";

const [dbPath, dataDir, level] = process.argv.slice(2);
setLogLevel(level);
const { done } = runRetentionAway({
  dbPath: dbPath!, nowMs: Date.now(), ceiling: null, dataDir: dataDir!, runningPaths: [],
  retention: { chatRetentionDays: 90, chatMaxTableBytes: 512 * 1024 * 1024, chatToolResultHeadChars: 2000 }
});
await done;
process.exit(0);
