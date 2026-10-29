import type { Database } from "bun:sqlite";

/** Your agent's page: its published versions, the page subagents' writes,
 *  what the user gave on it, and the digest of each file as last published
 *  or applied. */
export function initializeAgentPageSchema(db: Database): void {
  db.exec(`
    create table if not exists agent_page_versions (
      revision    integer primary key,
      html        text not null,
      writer      text not null,
      created_at  text not null
    )
  `);
  db.exec(`
    create table if not exists agent_page_writes (
      task_id      text primary key,
      title        text not null,
      status       text not null,
      started_at   text not null,
      finished_at  text,
      revision     integer,
      error        text
    )
  `);
  db.exec("create index if not exists idx_agent_page_writes_started on agent_page_writes(started_at)");
  db.exec(`
    create table if not exists agent_page_answers (
      id          text primary key,
      value_json  text not null,
      created_at  text not null,
      mailbox_id  text,
      read_at     text
    )
  `);
  // The data sources sources.json lists: each one's command, interval and
  // place, whether the user paused it, and its last value and error.
  // `revision` is bumped when its command changes: a run started before is dropped.
  db.exec(`
    create table if not exists agent_page_sources (
      name         text primary key,
      position     integer not null default 0,
      run          text not null,
      every_ms     integer not null,
      cwd          text,
      paused       integer not null default 0,
      next_run_at  text not null,
      last_run_at  text,
      value_json   text,
      value_at     text,
      last_error   text,
      revision     integer not null default 0
    )
  `);
  db.exec(`
    create table if not exists agent_page_files (
      name    text primary key,
      digest  text not null
    )
  `);
}
