import type { Database } from "bun:sqlite";

/** The old index: the entries' text again, tokenized as unicode61 splits it
 *  (a run of Chinese is one token). Made only where the words index cannot
 *  be. An install from before the words index keeps one until a deploy drops
 *  it; nothing writes or reads it there. */
export function createHistoryOldIndex(db: Database): void {
  db.exec(`
    create virtual table if not exists agent_message_search_fts using fts5(
      entry_id unindexed,
      message_id unindexed,
      thread_id unindexed,
      project_id unindexed,
      feature_id unindexed,
      role unindexed,
      source unindexed,
      content_text,
      tool_names,
      tokenize='unicode61'
    )
  `);
}

export function initializeAgentHistorySchema(db: Database): void {
  db.exec(`
    create table if not exists agent_message_search_entries (
      id                      text primary key,
      message_id              text not null unique,
      thread_id               text not null,
      project_id              text not null,
      feature_id              text,
      seq                     integer not null,
      role                    text not null,
      source                  text not null,
      content_text            text not null,
      tool_names_json         text,
      attachment_count        integer not null default 0,
      redaction_flags_json    text,
      message_created_at      text not null,
      thread_updated_at       text not null,
      indexed_at              text not null
    )
  `);
  db.exec(`
    create index if not exists idx_agent_message_search_project_time
      on agent_message_search_entries(project_id, message_created_at desc)
  `);
  db.exec(`
    create index if not exists idx_agent_message_search_feature_time
      on agent_message_search_entries(feature_id, message_created_at desc)
      where feature_id is not null
  `);
  db.exec(`
    create index if not exists idx_agent_message_search_thread_seq
      on agent_message_search_entries(thread_id, seq)
  `);
  // The entries read by word (history-words.ts): rowids run in time, the
  // rowid kept per entry, and which segmenter read them and whether all are in.
  // Only the index is kept: the text is in the entries table (a copy of it
  // would be most of the table's size). Deleting from such a table needs SQLite 3.43; on an
  // older one the table is not made, and the old index stands in for it.
  try {
    db.exec(`
      create virtual table if not exists agent_message_search_words using fts5(
        content_words,
        tool_names,
        content='',
        contentless_delete=1,
        tokenize='unicode61'
      )
    `);
  } catch (e) {
    console.warn(`[mandate] chat history: no words index on this SQLite (${e instanceof Error ? e.message : String(e)}); search keeps the old index`);
    createHistoryOldIndex(db);
  }
  db.exec(`
    create table if not exists agent_message_search_word_keys (
      entry_id    text primary key,
      word_rowid  integer not null unique,
      indexed_at  text not null
    )
  `);
  db.exec(`
    create table if not exists agent_message_search_words_state (
      key    text primary key,
      value  text not null
    )
  `);
  db.exec(`
    create table if not exists agent_message_search_skipped (
      message_id text primary key,
      indexed_at text not null
    )
  `);
  db.exec(`
    create table if not exists agent_history_read_handles (
      id                 text primary key,
      caller_thread_id   text not null,
      project_id         text not null,
      thread_id          text not null,
      message_id         text not null,
      seq                integer not null,
      time_preset        text not null,
      since              text,
      until              text,
      include_archived   integer not null default 0,
      reason             text,
      created_at         text not null,
      expires_at         text not null
    )
  `);
  db.exec(`
    create index if not exists idx_agent_history_read_handles_caller
      on agent_history_read_handles(caller_thread_id, created_at desc)
  `);
  db.exec(`
    create table if not exists agent_history_audit (
      id                 text primary key,
      caller_thread_id   text not null,
      wake_id            text,
      tool_name          text not null,
      project_id         text not null,
      feature_id         text,
      target_thread_id   text,
      time_preset        text not null,
      since              text,
      until              text,
      reason             text,
      query_hash         text,
      query_preview      text,
      result_count       integer not null default 0,
      chars_returned     integer not null default 0,
      metadata_json      text,
      created_at         text not null
    )
  `);
  db.exec(`
    create index if not exists idx_agent_history_audit_caller
      on agent_history_audit(caller_thread_id, created_at desc)
  `);
}
