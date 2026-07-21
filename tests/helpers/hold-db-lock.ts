/**
 * Holds an exclusive write lock on a sqlite file, then releases it by exiting.
 *
 * Runs as a child process because the lock has to be held by *another*
 * connection while the parent blocks inside a synchronous constructor — a
 * timer in the parent could never fire to release it.
 *
 * Usage: bun tests/helpers/hold-db-lock.ts <db-path> <hold-ms>
 * Prints "locked" once the lock is held; the parent waits for that line.
 */
import { Database } from "bun:sqlite";

const [dbPath, holdMsRaw] = process.argv.slice(2);
if (!dbPath) throw new Error("usage: hold-db-lock.ts <db-path> <hold-ms>");

const db = new Database(dbPath);
// A table makes the file a real database, so the parent's journal-mode switch
// has something to contend for rather than racing an empty file.
db.exec("create table if not exists lock_probe (x)");
db.exec("begin exclusive");
db.exec("insert into lock_probe (x) values (1)");

process.stdout.write("locked\n");

await Bun.sleep(Number(holdMsRaw) || 400);
db.exec("rollback");
db.close();
