import type { Database } from "bun:sqlite";

/** Personal agent's page: its published versions and their files, the page
 *  subagents' writes, what the user gave on it, and the digest of each file
 *  as last published or applied. */
export function initializeAgentPageSchema(db: Database): void {
  db.exec(`
    create table if not exists agent_page_versions (
      revision    integer primary key,
      html        text not null,
      writer      text not null,
      created_at  text not null
    )
  `);
  // Each version's files, by path in the page's folder, their content kept
  // once however many versions hold it. A version from before the folder
  // has no files here: its page is its html alone.
  db.exec(`
    create table if not exists agent_page_version_files (
      revision  integer not null,
      path      text not null,
      digest    text not null,
      primary key (revision, path)
    )
  `);
  db.exec("create index if not exists idx_agent_page_version_files_digest on agent_page_version_files(digest)");
  db.exec(`
    create table if not exists agent_page_blobs (
      digest  text primary key,
      bytes   blob not null
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
  // `revision` is a new random generation whenever the row is inserted or its
  // command changes: a run started before is dropped.
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
  // The scheduled updates updates.json lists: each one's cron and task,
  // whether the user paused it, when it is next due, how it last went, and
  // what had changed when it last started a run.
  db.exec(`
    create table if not exists agent_page_updates (
      name          text primary key,
      position      integer not null default 0,
      cron          text not null,
      task          text not null,
      paused        integer not null default 0,
      next_run_at   text,
      last_run_at   text,
      last_outcome  text,
      last_error    text,
      last_digest   text
    )
  `);
  // The page subagents scheduled updates started, by the update's name,
  // until each ends: one is an update's run whether or not its update is
  // still listed, through a restart too.
  db.exec(`
    create table if not exists agent_page_update_runs (
      task_id  text primary key,
      name     text not null
    )
  `);
  // A source failing in a row since when, how many runs, and when a page
  // subagent was last started to look into it; `command` is what failed
  // (its command and cwd), so a new one starts its own count.
  db.exec(`
    create table if not exists agent_page_source_health (
      name            text primary key,
      command         text not null,
      failing_since   text,
      failures        integer not null default 0,
      fix_started_at  text
    )
  `);
  db.exec(`
    create table if not exists agent_page_files (
      name    text primary key,
      digest  text not null
    )
  `);
}
