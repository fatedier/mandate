import type { Database } from "bun:sqlite";

/** The old index: the entries' text again, tokenized as unicode61 splits it
 *  (a run of Chinese is one token). Made only where the words index cannot
 *  be. */
export function createHistoryOldIndex(db: Database): void {
  db.exec(`
    create virtual table if not exists agent_message_search_fts using fts5(
      entry_id unindexed,
      message_id unindexed,
      thread_id unindexed,
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
      seq                     integer not null,
      role                    text not null,
      source                  text not null,
      content_text            text not null,
      tool_names_json         text,
      redaction_flags_json    text,
      message_created_at      text not null,
      indexed_at              text not null
    )
  `);
  db.exec(`
    create index if not exists idx_agent_message_search_thread_seq
      on agent_message_search_entries(thread_id, seq)
  `);
  // Each word match's thread and time, read without the entry's text: a
  // search keeps to its place and range here, before reading the rows it
  // returns, where every match would cost a read of its whole entry.
  db.exec(`
    create index if not exists idx_agent_message_search_entries_place
      on agent_message_search_entries(id, thread_id, message_created_at)
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
    // No merging as a message is written: SQLite's automerge folded the
    // segments now and then inside a write, tens of milliseconds on the
    // server's thread (more on a busy disk). The merging is done in small timed steps
    // instead (mergeHistoryWords). Kept in the index's own settings.
    db.exec("insert into agent_message_search_words(agent_message_search_words, rank) values('automerge', 0)");
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
  // How far a complete backfill read (history-store.ts) is a rowid, and SQLite
  // gives the newest rowid again once its message is deleted (a deleted
  // thread's): a message written after would sit below the mark, and if its
  // own indexing failed no backfill would look for it. A deletion that leaves
  // every message below the mark brings the mark down with it.
  db.exec(`
    create trigger if not exists agent_messages_backfill_mark
    after delete on agent_messages
    when (select cast(value as integer) from agent_message_search_words_state where key = 'backfill_checked_rowid')
       > (select coalesce(max(rowid), 0) from agent_messages)
    begin
      update agent_message_search_words_state
         set value = (select coalesce(max(rowid), 0) from agent_messages)
       where key = 'backfill_checked_rowid';
    end
  `);
  db.exec(`
    create table if not exists agent_message_search_skipped (
      message_id text primary key,
      indexed_at text not null
    )
  `);
}
