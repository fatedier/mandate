import type { Database } from "bun:sqlite";

export function initializePlansSchema(db: Database): void {
  db.exec(`create table if not exists feature_plans (
    feature_id     text primary key references features(id) on delete cascade,
    goal           text,
    conclusion     text,
    open_questions text not null default '[]',
    next_step_id   integer not null default 1,
    updated_at     text not null
  )`);
  db.exec(`create table if not exists feature_plan_steps (
    feature_id   text not null references features(id) on delete cascade,
    id           integer not null,
    position     integer not null,
    title        text not null,
    status       text not null check (status in ('pending','in_progress','blocked','done')),
    note         text,
    created_at   text not null,
    started_at   text,
    blocked_at   text,
    completed_at text,
    updated_at   text not null,
    primary key (feature_id, id)
  )`);
  db.exec(`create index if not exists idx_feature_plan_steps_order on feature_plan_steps(feature_id, position)`);
  db.exec(`create index if not exists idx_feature_plan_steps_status on feature_plan_steps(status, feature_id)`);
  db.exec(`create table if not exists feature_plan_goal_history (
    feature_id text not null references features(id) on delete cascade,
    goal       text not null,
    changed_at text not null
  )`);
  db.exec(`create index if not exists idx_feature_plan_goal_history on feature_plan_goal_history(feature_id, changed_at)`);
  // A worker's task record: its history (what it was asked, did, decided and
  // left open), rewritten in place by memory extraction; the plan is its
  // current state. One per worker; it goes with the worker.
  db.exec(`create table if not exists feature_records (
    feature_id       text primary key references features(id) on delete cascade,
    id               text not null unique,
    project_id       text not null,
    content          text not null,
    source_thread_id text,
    created_at       text not null,
    updated_at       text not null,
    metadata_json    text
  )`);
  db.exec(`create index if not exists idx_feature_records_project on feature_records(project_id, updated_at desc)`);
  // The records read by word (record-store.ts): each record's text with its
  // unspaced runs split into words, by the record's rowid. Records are few,
  // so the text is kept here too (no contentless table, no SQLite 3.43 need).
  db.exec(`create virtual table if not exists feature_record_words using fts5(
    content_words,
    tokenize='unicode61'
  )`);
  db.exec(`create table if not exists feature_record_words_state (
    key   text primary key,
    value text not null
  )`);
  db.exec(`create trigger if not exists feature_records_words_delete after delete on feature_records begin
    delete from feature_record_words where rowid = old.rowid;
  end`);
}
