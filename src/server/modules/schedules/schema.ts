import type { Database } from "bun:sqlite";

/** Schedules (a cron, a model-free check, the duty thread it wakes), their
 *  check history, the duty threads' own state, and what became of each duty
 *  reply. No CHECK constraints: SQLite cannot alter one later. */
export function initializeSchedulesSchema(db: Database): void {
  db.exec(`
    create table if not exists agent_schedules (
      id                    text primary key,
      thread_id             text not null,
      name                  text not null,
      cron                  text not null,
      timezone              text not null,
      check_script          text not null,
      check_timeout_ms      integer not null,
      brief                 text not null,
      status                text not null,
      paused_reason         text,
      next_due_at           text,
      last_run_at           text,
      last_outcome          text,
      consecutive_failures  integer not null default 0,
      check_state_json      text not null default '{}',
      seen_items_json       text not null default '[]',
      pending_wake_json     text,
      pending_message_id    text,
      pending_check_json    text,
      running_due_at        text,
      test_started_at       text,
      checks_run            integer not null default 0,
      created_at            text not null,
      updated_at            text not null,
      revision              integer not null default 0
    )
  `);
  db.exec("create index if not exists idx_agent_schedules_thread on agent_schedules(thread_id)");
  db.exec("create index if not exists idx_agent_schedules_due on agent_schedules(next_due_at) where status = 'active'");
  db.exec(`
    create table if not exists agent_schedule_runs (
      id           integer primary key autoincrement,
      schedule_id  text not null,
      thread_id    text not null,
      due_at       text not null,
      started_at   text not null,
      finished_at  text not null,
      outcome      text not null,
      exit_code    integer,
      duration_ms  integer not null default 0,
      line         text not null default '',
      missed       integer not null default 0
    )
  `);
  db.exec("create index if not exists idx_agent_schedule_runs_schedule on agent_schedule_runs(schedule_id, id)");
  db.exec(`
    create table if not exists agent_duty_threads (
      thread_id      text primary key,
      level          text not null,
      notes_dir      text not null,
      last_told_seq  integer not null default 0,
      created_at     text not null
    )
  `);
  db.exec(`
    create table if not exists agent_duty_reports (
      message_id  text primary key,
      thread_id   text not null,
      outcome     text not null,
      at          text not null
    )
  `);
  db.exec("create index if not exists idx_agent_duty_reports_thread on agent_duty_reports(thread_id)");
  // The duty threads the owner put in the sidebar, and when: listed in that
  // order. A thread no longer on duty is not listed; its row goes with it.
  db.exec(`
    create table if not exists agent_duty_sidebar (
      thread_id  text primary key,
      added_at   text not null
    )
  `);
}
