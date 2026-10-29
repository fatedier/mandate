import type { Database } from "bun:sqlite";

function createMemoryEntriesTable(db: Database): void {
  db.exec(`
    create table if not exists memory_entries (
      id                text primary key,
      scope             text not null check (scope in ('user','project')),
      project_id        text,
      feature_id        text,
      type              text not null check (type in ('preference','knowledge','task')),
      source            text not null check (source in ('user','agent','extraction')),
      user_quote        text,
      content           text not null,
      status            text not null check (status in ('available','archived')),
      source_thread_id  text,
      source_message_id text,
      created_at        text not null,
      updated_at        text not null,
      metadata_json     text
    )
  `);
}

/** Indexes, the FTS index over content, and the triggers that keep it in step. */
function createMemoryEntryIndexes(db: Database): void {
  db.exec(`
    create index if not exists idx_memory_entries_lookup
      on memory_entries(status, scope, project_id, updated_at desc)
  `);
  db.exec(`
    create index if not exists idx_memory_entries_source_thread
      on memory_entries(source_thread_id)
      where source_thread_id is not null
  `);
  db.exec(`
    create virtual table if not exists memory_entries_fts using fts5(
      content,
      content='memory_entries',
      content_rowid='rowid',
      tokenize='unicode61'
    )
  `);
  db.exec(`
    create trigger if not exists memory_entries_ai after insert on memory_entries begin
      insert into memory_entries_fts(rowid, content) values (new.rowid, new.content);
    end
  `);
  db.exec(`
    create trigger if not exists memory_entries_ad after delete on memory_entries begin
      insert into memory_entries_fts(memory_entries_fts, rowid, content) values ('delete', old.rowid, old.content);
    end
  `);
  db.exec(`
    create trigger if not exists memory_entries_au after update of content on memory_entries begin
      insert into memory_entries_fts(memory_entries_fts, rowid, content) values ('delete', old.rowid, old.content);
      insert into memory_entries_fts(rowid, content) values (new.rowid, new.content);
    end
  `);
}

function createMemoryEmbeddingsTable(db: Database): void {
  db.exec(`
    create table if not exists memory_embeddings (
      entry_id    text not null references memory_entries(id) on delete cascade,
      model       text not null,
      dimensions  integer not null,
      vector_json text not null,
      updated_at  text not null,
      revision    integer not null default 0,
      primary key (entry_id, model)
    )
  `);
  // `revision` is what the in-memory vector cache compares against; `updated_at` cannot
  // serve, because it is millisecond text and two writes to one row can share a value.
  db.exec(`
    create index if not exists idx_memory_embeddings_revision
      on memory_embeddings(model, entry_id, revision)
  `);
}

function createMemoryBriefsTable(db: Database): void {
  // project_id is '' for the user brief: a primary key cannot tell NULLs apart.
  db.exec(`
    create table if not exists memory_briefs (
      scope        text not null check (scope in ('user','project')),
      project_id   text not null default '',
      content      text not null,
      input_digest text not null,
      built_at     text not null,
      run_id       text,
      primary key (scope, project_id)
    )
  `);
}

/** Each time a memory reached an agent or came up again, for statistics on
 *  which memories are used. No foreign key: a use outlives what it names. */
function createMemoryUsesTable(db: Database): void {
  db.exec(`
    create table if not exists memory_uses (
      memory_id text not null,
      kind      text not null check (kind in ('search','read','restated','repeat')),
      at        text not null,
      thread_id text,
      agent     text,
      rank      integer
    )
  `);
  db.exec(`
    create index if not exists idx_memory_uses_memory
      on memory_uses(memory_id, at)
  `);
}

export function initializeMemorySchema(db: Database): void {
  createMemoryBriefsTable(db);
  createMemoryUsesTable(db);
  createDreamTables(db);
  createMemoryEntriesTable(db);
  createMemoryEntryIndexes(db);
  createMemoryEmbeddingsTable(db);
}

function createDreamTables(db: Database): void {
  db.exec(`
    create table if not exists memory_dream_runs (
      id              text primary key,
      trigger         text not null,
      status          text not null check (status in ('running','succeeded','failed','skipped')),
      provider        text not null default '',
      model           text not null default '',
      phase           text not null,
      project_id      text,
      candidate_count integer not null default 0,
      applied_count   integer not null default 0,
      error_json      text,
      metadata_json   text,
      started_at      text not null,
      finished_at     text,
      available_count_before integer,
      available_count_after  integer
    )
  `);
  db.exec(`
    create index if not exists idx_memory_dream_runs_finished
      on memory_dream_runs(finished_at desc, started_at desc)
  `);
  db.exec(`
    create index if not exists idx_memory_dream_runs_partition
      on memory_dream_runs(phase, project_id, finished_at desc, started_at desc)
  `);
  db.exec(`
    create table if not exists memory_dream_actions (
      id               text primary key,
      run_id           text not null references memory_dream_runs(id) on delete cascade,
      action_type      text not null,
      status           text not null check (status in ('applied','rejected','failed')),
      memory_id        text not null,
      target_memory_id text,
      before_json      text,
      after_json       text,
      reason           text not null default '',
      source_json      text,
      error_json       text,
      created_at       text not null,
      applied_at       text
    )
  `);
  db.exec(`
    create index if not exists idx_memory_dream_actions_run
      on memory_dream_actions(run_id, created_at)
  `);
}
