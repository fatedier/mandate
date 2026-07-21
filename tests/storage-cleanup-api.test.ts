import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { truncateChatToolResults } from "../src/server/platform/db/retention.js";
import { measureDatabaseBytes } from "../src/server/modules/settings/settings-routes.js";

test("an unthrottled cleanup shortens every eligible row, not just one tick's worth", () => {
  // The manual action's whole point is that it finishes; the hourly pass is the
  // one that must stay under a cap. maxRows here is the number of rows, not the
  // 200-per-tick throttle.
  const db = new Database(":memory:");
  db.exec(`
    create table agent_messages (
      id text primary key, thread_id text not null, seq integer not null,
      role text not null, source text not null default 'user',
      content text not null, created_at text not null
    )
  `);
  for (let i = 0; i < 500; i += 1) {
    db.prepare(
      "insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values (?,?,?,?,?,?,?)"
    ).run(`r${i}`, "t", 1, "tool", "tool",
      JSON.stringify({ type: "tool_result", toolCallId: `c${i}`, toolName: "bash", result: "x".repeat(5000) }),
      "2020-01-01T00:00:00.000Z");
  }

  const n = truncateChatToolResults(db, {
    headChars: 2000,
    cutoffIso: "2100-01-01T00:00:00.000Z",
    maxRows: Number.MAX_SAFE_INTEGER,
    overCeiling: false
  });

  expect(n).toBe(500);
  const remaining = db.prepare(
    "select count(*) c from agent_messages where length(content) > 3000"
  ).get() as { c: number };
  expect(remaining.c).toBe(0);
});

test("measureDatabaseBytes reports the file size, which a vacuum moves, not the content sum, which it does not", () => {
  // A cleanup that shortens rows (or, as here, a plain delete standing in for
  // it) frees interior pages that SQLite keeps in its freelist rather than
  // returning to the OS -- the file only shrinks once vacuum runs. The
  // content sum, by contrast, drops the instant rows are removed and is
  // untouched by vacuum. bytesBefore/bytesAfter must track the former: it is
  // the only one of the two a vacuum can move, and it is what the user's
  // disk actually shows.
  const db = new Database(":memory:");
  db.exec(`
    create table agent_messages (
      id text primary key, thread_id text not null, seq integer not null,
      role text not null, source text not null default 'user',
      content text not null, created_at text not null
    )
  `);
  const insert = db.prepare(
    "insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values (?,?,?,?,?,?,?)"
  );
  for (let i = 0; i < 3000; i += 1) {
    insert.run(`r${i}`, "t", i, "tool", "tool", "x".repeat(3000), "2020-01-01T00:00:00.000Z");
  }
  const contentSum = () => (db.prepare(
    "select coalesce(sum(length(content)), 0) b from agent_messages"
  ).get() as { b: number }).b;

  // Delete 90% of rows directly -- simplest way to leave the database with
  // free pages, without needing a multi-hundred-MB fixture to exercise the
  // truncation path itself.
  db.exec("delete from agent_messages where rowid % 10 != 0");

  const pageBytesBeforeVacuum = measureDatabaseBytes(db);
  const contentSumBeforeVacuum = contentSum();
  // The two metrics must actually be different numbers here, or the rest of
  // this test would not be distinguishing them from anything.
  expect(pageBytesBeforeVacuum).not.toBe(contentSumBeforeVacuum);

  db.exec("vacuum");

  const pageBytesAfterVacuum = measureDatabaseBytes(db);
  const contentSumAfterVacuum = contentSum();

  // The quantity this route reports moves across the vacuum...
  expect(pageBytesAfterVacuum).toBeLessThan(pageBytesBeforeVacuum);
  // ...while the content sum -- the number a naive bytesBefore/bytesAfter
  // would have reported before this fix -- does not, since no row's content
  // changed. If it had been used, a run's whole reclaimed vacuum space would
  // vanish from what the user is told.
  expect(contentSumAfterVacuum).toBe(contentSumBeforeVacuum);
});
