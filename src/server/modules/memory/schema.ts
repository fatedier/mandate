import type { Database } from "bun:sqlite";
import { ensureColumn } from "../../platform/db/ensure-column.js";

export function initializeMemorySchema(db: Database): void {
  resetLegacyMemorySchema(db);
  db.exec(`
    create table if not exists memory_entries (
      id                text primary key,
      scope             text not null check (scope in ('user','global','project','feature')),
      project_id        text,
      feature_id        text,
      kind              text not null check (kind in ('episodic','semantic','preference','procedural')),
      content           text not null,
      status            text not null check (status in ('available','archived','deleted')),
      strength          real not null default 0.5,
      confidence        real not null default 0.7,
      cues_json         text,
      source            text not null check (source in ('explicit_user','agent_flush','tool_result','manual')),
      source_thread_id  text,
      source_message_id text,
      created_at        text not null,
      updated_at        text not null,
      last_recalled_at  text,
      recall_count      integer not null default 0,
      last_used_at      text,
      use_count         integer not null default 0,
      feedback_json     text,
      expires_at        text,
      supersedes        text,
      metadata_json     text
    )
  `);
  db.exec(`
    create index if not exists idx_memory_entries_lookup
      on memory_entries(status, scope, project_id, feature_id, updated_at desc)
  `);
  db.exec(`
    create index if not exists idx_memory_entries_source_thread
      on memory_entries(source_thread_id)
      where source_thread_id is not null
  `);
  db.exec(`
    create virtual table if not exists memory_entries_fts using fts5(
      content,
      cues,
      kind unindexed,
      scope unindexed,
      project_id unindexed,
      feature_id unindexed,
      content='memory_entries',
      content_rowid='rowid',
      tokenize='unicode61'
    )
  `);
  db.exec(`
    create trigger if not exists memory_entries_ai after insert on memory_entries begin
      insert into memory_entries_fts(rowid, content, cues, kind, scope, project_id, feature_id)
      values (new.rowid, new.content, coalesce(new.cues_json, ''), new.kind, new.scope, new.project_id, new.feature_id);
    end
  `);
  db.exec(`
    create trigger if not exists memory_entries_ad after delete on memory_entries begin
      insert into memory_entries_fts(memory_entries_fts, rowid, content, cues, kind, scope, project_id, feature_id)
      values ('delete', old.rowid, old.content, coalesce(old.cues_json, ''), old.kind, old.scope, old.project_id, old.feature_id);
    end
  `);
  db.exec(`
    create trigger if not exists memory_entries_au after update on memory_entries begin
      insert into memory_entries_fts(memory_entries_fts, rowid, content, cues, kind, scope, project_id, feature_id)
      values ('delete', old.rowid, old.content, coalesce(old.cues_json, ''), old.kind, old.scope, old.project_id, old.feature_id);
      insert into memory_entries_fts(rowid, content, cues, kind, scope, project_id, feature_id)
      values (new.rowid, new.content, coalesce(new.cues_json, ''), new.kind, new.scope, new.project_id, new.feature_id);
    end
  `);
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
  ensureColumn(db, "memory_embeddings", "revision", "integer not null default 0");
  // A superseded index over (model, entry_id, updated_at) lived here briefly. Drop it by
  // name: `create index if not exists` would leave the old definition standing, and the
  // probe below would then pay a table lookup per row for a column it could not cover.
  db.exec("drop index if exists idx_memory_embeddings_stamp");
  db.exec(`
    create index if not exists idx_memory_embeddings_revision
      on memory_embeddings(model, entry_id, revision)
  `);
  db.exec(`
    create table if not exists memory_dream_runs (
      id              text primary key,
      trigger         text not null,
      status          text not null check (status in ('running','succeeded','failed','skipped')),
      provider        text not null default '',
      model           text not null default '',
      phase           text not null default 'legacy',
      project_id      text,
      candidate_count integer not null default 0,
      applied_count   integer not null default 0,
      error_json      text,
      metadata_json   text,
      started_at      text not null,
      finished_at     text
    )
  `);
  db.exec(`
    create index if not exists idx_memory_dream_runs_finished
      on memory_dream_runs(finished_at desc, started_at desc)
  `);
  ensureColumn(db, "memory_dream_runs", "available_count_before", "integer");
  ensureColumn(db, "memory_dream_runs", "available_count_after", "integer");
  ensureColumn(db, "memory_dream_runs", "phase", "text not null default 'legacy'");
  ensureColumn(db, "memory_dream_runs", "project_id", "text");
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
      confidence       real,
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

function resetLegacyMemorySchema(db: Database): void {
  const columns = db.prepare("pragma table_info(memory_entries)").all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  const names = new Set(columns.map((column) => column.name));
  const table = db.prepare("select sql from sqlite_master where type = 'table' and name = 'memory_entries'")
    .get() as { sql?: string } | undefined;
  const hasSourceStatus = Boolean(table?.sql?.includes("'source'"));
  if (
    names.has("strength")
    && names.has("cues_json")
    && names.has("recall_count")
    && names.has("last_used_at")
    && names.has("use_count")
    && names.has("feedback_json")
    && !hasSourceStatus
  ) return;
  db.exec(`
    drop table if exists memory_embeddings;
    drop table if exists memory_entries_fts;
    drop table if exists memory_entries;
  `);
}
