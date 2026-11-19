import type { Database } from "bun:sqlite";

/** The rows the connection's last INSERT, UPDATE or DELETE changed itself.
 *  Bun's `run().changes` also counts the rows its triggers wrote (an update of
 *  two rows with a one-row trigger reports 4); SQLite's changes() counts the
 *  statement's own rows. agent_messages and agent_wakes carry triggers
 *  (modules/agent/schema.ts), so counts of their rows are taken here. */
export function directChanges(db: Database): number {
  return (db.prepare("select changes() as n").get() as { n: number }).n;
}
