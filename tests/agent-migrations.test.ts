import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { agentMigrations } from "../src/server/modules/agent/migrations.js";
import { runPendingMigrations } from "../src/server/platform/db/migrations.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

// Prefixed with the agent module's registry id, "agents", not its directory
// name: db-migrations-wiring pins every id to the module that declares it.
const MIGRATION_ID = "agents/2026-07-29-index-overview-history";

function skipMark(db: Database, messageId: string): unknown {
  return db
    .prepare("select message_id from agent_message_search_skipped where message_id = ?")
    .get(messageId);
}

function indexEntry(db: Database, messageId: string): unknown {
  return db
    .prepare("select message_id from agent_message_search_entries where message_id = ?")
    .get(messageId);
}

test("agentMigrations: declares the overview reindex with a module-prefixed id", () => {
  const ids = agentMigrations.map((migration) => migration.id);
  expect(ids).toContain(MIGRATION_ID);
  for (const id of ids) expect(id.startsWith("agents/")).toBe(true);
});

const RENAME_MIGRATION_ID = "agents/2026-08-17-agent-identity-rename";
const DROP_MESSAGE_MARKER_ID = "agents/2026-09-15-drop-message-superseded-marker";

function messageColumns(db: Database): string[] {
  return (db.prepare("pragma table_info(agent_messages)").all() as Array<{ name: string }>)
    .map((column) => column.name);
}

test("message marker removal preserves history, active prompt, and search entries", () => {
  const env = freshStoresEnv("md-message-marker-");
  try {
    const db = env.store.db;
    db.exec("alter table agent_messages add column superseded_by_summary_id text");
    db.prepare("delete from schema_migrations where id = ?").run(DROP_MESSAGE_MARKER_ID);
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const original = env.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "Original conversation" }
    });
    const summary = env.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: { type: "summary", summary: "Conversation summary", replacedRange: [1, 1], replacedCount: 1 }
    });
    db.prepare("update agent_messages set superseded_by_summary_id = ? where id = ?")
      .run(summary.id, original.id);
    const rows = db.prepare(`
      select rowid, id, thread_id, seq, role, source, source_thread_id, wake_id, content, created_at
      from agent_messages order by rowid
    `);
    const before = rows.all();
    const searchEntries = db.prepare("select * from agent_message_search_entries order by id").all();
    const searchFts = db.prepare("select * from agent_message_search_fts order by message_id").all();
    expect(searchEntries.length).toBeGreaterThan(0);

    runPendingMigrations(db, agentMigrations);

    expect(messageColumns(db)).not.toContain("superseded_by_summary_id");
    expect(rows.all()).toEqual(before);
    expect(env.agentStore.getMessages(thread.id)).toEqual([original, summary]);
    expect(env.agentStore.getActiveMessages(thread.id)).toEqual([summary]);
    expect(db.prepare("select * from agent_message_search_entries order by id").all()).toEqual(searchEntries);
    expect(db.prepare("select * from agent_message_search_fts order by message_id").all()).toEqual(searchFts);
    expect(db.prepare("pragma foreign_key_check").all()).toEqual([]);

    initializeAgentSchema(db);
    runPendingMigrations(db, agentMigrations);
    expect(messageColumns(db)).not.toContain("superseded_by_summary_id");
    expect(rows.all()).toEqual(before);
    expect(db.prepare("select id from schema_migrations where id = ?").all(DROP_MESSAGE_MARKER_ID))
      .toEqual([{ id: DROP_MESSAGE_MARKER_ID }]);
  } finally { env.cleanup(); }
});

test("fresh databases start without the message marker and record its migration", () => {
  const env = freshStoresEnv("md-message-marker-fresh-");
  try {
    expect(messageColumns(env.store.db)).not.toContain("superseded_by_summary_id");
    expect(env.store.db.prepare("select id from schema_migrations where id = ?").get(DROP_MESSAGE_MARKER_ID))
      .toEqual({ id: DROP_MESSAGE_MARKER_ID });
  } finally { env.cleanup(); }
});

test("agent identity rename migrates persisted scope and source values", () => {
  const env = freshStoresEnv("md-agent-rename-");
  try {
    const db = env.store.db;
    const now = new Date().toISOString();

    // Seed old-shape rows exactly as a pre-rename database holds them. Raw
    // SQL on purpose: the stores are being renamed by later tasks, and this
    // test must keep describing the OLD persisted shape either way.
    const insertThread = db.prepare(
      "insert into agent_threads (id, scope, scope_id, kind, created_at, updated_at) values (?, ?, ?, 'main', ?, ?)"
    );
    insertThread.run("t-ov", "overview", null, now, now);
    insertThread.run("t-f1", "feature", "f1", now, now);

    db.prepare(
      "insert into agent_tasks (id, feature_id, thread_id, source, channel, title, message, status, created_at, updated_at) " +
      "values ('task-1', 'f1', 't-f1', 'overview', 'overview', 'T', 'M', 'open', ?, ?)"
    ).run(now, now);

    const insertMessage = db.prepare(
      "insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values (?, ?, ?, 'user', ?, '{}', ?)"
    );
    insertMessage.run("m-ov", "t-f1", 1, "overview", now);
    insertMessage.run("m-self", "t-ov", 1, "manager-self", now);

    const insertMailbox = db.prepare(
      "insert into agent_mailbox (id, thread_id, role, source, content, status, created_at) values (?, ?, 'user', ?, '{}', 'pending', ?)"
    );
    insertMailbox.run("mb-ov", "t-f1", "overview", now);
    insertMailbox.run("mb-self", "t-ov", "manager-self", now);

    // work_items.feature_id references features(id), so back both rows with
    // real features. Ids chosen so `order by id` reads feature-agent first.
    const projectId = seedProject(env.projects);
    const featureA = seedFeature(env.features, projectId, { tmuxWindowName: "wa" });
    const featureB = seedFeature(env.features, projectId, { name: "G", tmuxWindowName: "wb" });
    // seedFeature already created each feature's work_item; stamp the old
    // author values onto those rows, with ids fixed so `order by id` reads
    // the feature-agent row first.
    const stampWorkItem = db.prepare(
      "update work_items set id = ?, summary_updated_by = ? where feature_id = ?"
    );
    stampWorkItem.run("wi-a", "feature-agent", featureA);
    stampWorkItem.run("wi-b", "overview", featureB);

    // schema.ts already built the NEW index, so on this database the
    // migration's drop/create-index lines would be no-ops with or without
    // the code under test. Put the index landscape back into its pre-rename
    // shape — old name present, new name absent — so the asserted end state
    // can only come from the migration's own DDL.
    db.exec("drop index if exists idx_agent_threads_manager_singleton");
    db.exec(`
      create unique index idx_agent_threads_overview_singleton
        on agent_threads(scope)
        where kind = 'main' and scope = 'overview' and archived_at is null
    `);

    // MandateStore's constructor already ran the rename against the then-empty
    // database; forget that so the runner meets the seeded rows the way it
    // meets a real database at upgrade time.
    db.prepare("delete from schema_migrations where id = ?").run(RENAME_MIGRATION_ID);

    runPendingMigrations(db, agentMigrations);

    expect(
      (db.prepare("select count(*) c from agent_threads where scope in ('overview','feature')").get() as { c: number }).c
    ).toBe(0);
    expect(
      (db.prepare("select scope from agent_threads where scope_id = 'f1'").get() as { scope: string }).scope
    ).toBe("worker");
    expect(
      (db.prepare("select count(*) c from agent_tasks where channel='overview' or source='overview'").get() as { c: number }).c
    ).toBe(0);
    expect(
      (db.prepare("select count(*) c from agent_messages where source in ('overview','manager-self')").get() as { c: number }).c
    ).toBe(0);
    expect(
      (db.prepare("select count(*) c from agent_mailbox where source in ('overview','manager-self')").get() as { c: number }).c
    ).toBe(0);
    expect(
      (db.prepare("select source from agent_messages where id = 'm-self'").get() as { source: string }).source
    ).toBe("self");
    expect(
      (db.prepare("select summary_updated_by from work_items order by id").all() as { summary_updated_by: string }[])
        .map((r) => r.summary_updated_by)
    ).toEqual(["worker", "manager"]);

    // The singleton index is rebuilt under the new name — and it must still
    // enforce: a second active manager main thread is rejected.
    const idx = (db
      .prepare("select name from sqlite_master where type='index' and name like '%singleton%'")
      .all() as { name: string }[]).map((r) => r.name);
    expect(idx).toContain("idx_agent_threads_manager_singleton");
    expect(idx).not.toContain("idx_agent_threads_overview_singleton");
    expect(() =>
      insertThread.run("t-ov-2", "manager", null, now, now)
    ).toThrow();
  } finally {
    env.cleanup();
  }
});

test("overview reindex: clears skip marks for overview main messages only", () => {
  const env = freshStoresEnv("md-agent-mig-");
  try {
    const projectId = seedProject(env.projects, {
      name: "Alpha", workingDir: "/alpha", tmuxSessionName: "alpha"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "Login", tmuxWindowName: "login"
    });
    const overview = env.agentStore.getOrCreateThread("manager", null);
    const feature = env.agentStore.getOrCreateThread("worker", featureId);

    const overviewMessage = env.agentStore.appendMessage({
      threadId: overview.id, role: "user", source: "user",
      content: { type: "text", text: "overview text" }
    });
    const sideMessage = env.agentStore.appendMessage({
      threadId: env.agentStore.createSideThread(overview.id).id,
      role: "user", source: "user",
      content: { type: "text", text: "side chatter" }
    });
    const featureMessage = env.agentStore.appendMessage({
      threadId: feature.id, role: "user", source: "user",
      content: { type: "text", text: "feature text" }
    });
    const featureRuntime = env.agentStore.appendMessage({
      threadId: feature.id, role: "user", source: "runtime-context",
      content: { type: "text", text: "runtime preamble" }
    });

    // The indexer now accepts overview messages, so put this one back into the
    // state the migration exists to repair: no index entry, and the skip mark
    // the old indexer left behind when it rejected overview threads.
    env.store.db.prepare("delete from agent_message_search_entries where message_id = ?")
      .run(overviewMessage.id);
    env.store.db.prepare("delete from agent_message_search_fts where message_id = ?")
      .run(overviewMessage.id);
    env.store.db.prepare(
      "insert into agent_message_search_skipped (message_id, indexed_at) values (?, ?) " +
      "on conflict(message_id) do update set indexed_at = excluded.indexed_at"
    ).run(overviewMessage.id, new Date().toISOString());

    // These two are marked by the current indexer, not by the fixture: a side
    // thread and a runtime-context message are unindexable by design. Clearing
    // their marks would make every later search reconsider them forever.
    expect(skipMark(env.store.db, sideMessage.id)).not.toBeNull();
    expect(skipMark(env.store.db, featureRuntime.id)).not.toBeNull();

    // freshStoresEnv opens a MandateStore, and its constructor already ran this
    // migration against the then-empty database. Forget that, so the runner
    // meets the seeded rows the way it meets a real database at upgrade time.
    // On a real old database this migration runs BEFORE the identity rename,
    // while thread scopes still read overview/feature — so flip the seeded
    // threads back to the old vocabulary and replay both in their real order.
    env.store.db.prepare("update agent_threads set scope='overview' where scope='manager'").run();
    env.store.db.prepare("update agent_threads set scope='feature' where scope='worker'").run();
    env.store.db.prepare("delete from schema_migrations where id = ?").run(MIGRATION_ID);
    env.store.db.prepare("delete from schema_migrations where id = ?").run(RENAME_MIGRATION_ID);

    runPendingMigrations(env.store.db, agentMigrations);

    expect(skipMark(env.store.db, overviewMessage.id)).toBeNull();
    expect(skipMark(env.store.db, sideMessage.id)).not.toBeNull();
    expect(skipMark(env.store.db, featureRuntime.id)).not.toBeNull();
    // Marks are all it touches: the feature message keeps the entry it already
    // had, and the message rows themselves survive.
    expect(indexEntry(env.store.db, featureMessage.id)).not.toBeNull();
    for (const id of [overviewMessage.id, sideMessage.id, featureMessage.id, featureRuntime.id]) {
      expect(env.agentStore.getMessageById(id)).not.toBeNull();
    }
    // Recorded, so a restart does not repeat the delete.
    expect(
      env.store.db.prepare("select id from schema_migrations where id = ?").get(MIGRATION_ID)
    ).not.toBeNull();
  } finally {
    env.cleanup();
  }
});
