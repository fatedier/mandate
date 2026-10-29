import type { Database } from "bun:sqlite";

export function initializeAgentSchema(db: Database): void {
  db.exec("pragma foreign_keys = on");
  db.exec(`
    create table if not exists agent_threads (
      id           text primary key,
      scope        text not null,
      scope_id     text,
      created_at   text not null,
      updated_at   text not null,
      archived_at  text,
      title        text,
      seen_seq     integer not null default 0,
      -- 1 once the user set the title (renamed it, or opened the thread with
      -- it): the manager's name_thread no longer changes it.
      title_by_user integer not null default 0,
      -- The model the thread was switched to in its composer
      -- (provider/model); null: its route's.
      model_override text
    )
  `);

  db.exec(`
    create unique index if not exists idx_agent_threads_scope_active
      on agent_threads(scope, scope_id)
      where scope_id is not null and archived_at is null
  `);
  db.exec(`
    create table if not exists agent_messages (
      id                       text primary key,
      thread_id                text not null,
      seq                      integer not null,
      role                     text not null,
      source                   text not null default 'user',
      source_thread_id         text,
      wake_id                  text,
      content                  text not null,
      created_at               text not null
    )
  `);
  db.exec(`
    create index if not exists idx_agent_messages_thread_seq
      on agent_messages(thread_id, seq)
  `);
  db.exec(`
    create index if not exists idx_agent_messages_wake
      on agent_messages(wake_id)
  `);
  // Only failure rows: a wake's ending is read on every thread list.
  db.exec(`
    create index if not exists idx_agent_messages_wake_failure
      on agent_messages(wake_id, seq) where source = 'wake-failure'
  `);
  db.exec(`
    create table if not exists agent_wakes (
      id                 text primary key,
      thread_id          text not null,
      reason             text not null,
      trigger_message_id text,
      status             text not null,
      step_count         integer not null default 0,
      last_input_tokens  integer,
      max_input_tokens   integer,
      error_message      text,
      started_at         text not null,
      finished_at        text,
      metadata_json      text,
      cancel_requested_at text,
      -- When last_input_tokens was measured. A wake that compacts at its gate
      -- measures the compacted window itself, long before it finishes.
      last_input_at      text
    )
  `);
  db.exec(`
    create index if not exists idx_agent_wakes_thread
      on agent_wakes(thread_id, started_at desc)
  `);
  db.exec(`
    create table if not exists agent_alarms (
      id          text primary key,
      thread_id   text not null,
      fire_at     text not null,
      note        text not null default '',
      status      text not null check (status in ('pending','fired','canceled')),
      created_at  text not null,
      fired_at    text
    )
  `);
  db.exec(`
    create index if not exists idx_agent_alarms_pending
      on agent_alarms(fire_at)
      where status = 'pending'
  `);
  db.exec(`
    create index if not exists idx_agent_alarms_thread
      on agent_alarms(thread_id, fire_at desc)
  `);
  db.exec(`
    create table if not exists agent_window_watches (
      id          text primary key,
      thread_id   text not null,
      window_key  text not null,
      pane_id     text not null,
      stable_ms   integer not null,
      note        text not null default '',
      created_at  text not null,
      timeout_at  text not null,
      timeout_ms  integer,
      -- The pane's name when the watch was registered: its event and its
      -- waiting line name the pane even where the chat has not loaded the call
      -- that named it. Null for a pane with no name.
      pane_name   text
    )
  `);

  db.exec(`
    create index if not exists idx_agent_window_watches_thread
      on agent_window_watches(thread_id)
  `);
  // Command monitors: one row per pending or fired-but-
  // undelivered monitor. A row is deleted when its wake is delivered, it is
  // cancelled, or its thread goes; never at shutdown.
  db.exec(`
    create table if not exists agent_monitors (
      id                   text primary key,
      thread_id            text not null,
      command              text not null,
      cwd                  text not null,
      every_ms             integer not null,
      wake_when            text not null check (wake_when in ('changed','succeeds')),
      note                 text not null,
      timeout_ms           integer not null,
      created_at           text not null,
      timeout_at           text not null,
      next_run_at          text not null,
      last_run_at          text,
      last_output          text not null default '',
      consecutive_failures integer not null default 0,
      last_error           text,
      fired_result         text check (fired_result in ('changed','succeeded','timeout','failing')),
      fired_at             text,
      fired_payload_json   text,
      fired_message_id     text,
      revision             integer not null default 0,
      description          text,
      -- How the last run ended, for a timeout to say so (a broken check under
      -- succeeds looks like one still waiting).
      last_exit_code       integer,
      last_stderr          text not null default ''
    )
  `);
  db.exec(`create index if not exists idx_agent_monitors_thread on agent_monitors(thread_id)`);
  // A command monitor's scheduled checks, for the chat's card:
  // when, how it ended, its output's last line. They go with their monitor.
  db.exec(`
    create table if not exists agent_monitor_runs (
      id         integer primary key autoincrement,
      monitor_id text not null,
      thread_id  text not null,
      at         text not null,
      exit_code  integer,
      timed_out  integer not null default 0,
      changed    integer not null default 0,
      line       text not null default ''
    )
  `);
  db.exec(`create index if not exists idx_agent_monitor_runs_monitor on agent_monitor_runs(monitor_id, id)`);
  db.exec(`create index if not exists idx_agent_monitors_due on agent_monitors(next_run_at) where fired_result is null`);
  db.exec(`
    create table if not exists agent_mailbox (
      id                   text primary key,
      thread_id            text not null,
      role                 text not null,
      source               text not null,
      source_thread_id     text,
      content              text not null,
      trigger_turn         integer not null default 1,
      status               text not null,
      wake_id              text,
      delivered_message_id text,
      created_at           text not null,
      delivered_at         text
    )
  `);
  db.exec(`
    create index if not exists idx_agent_mailbox_thread_status
      on agent_mailbox(thread_id, status, created_at asc)
  `);
  db.exec(`
    create index if not exists idx_agent_mailbox_wake
      on agent_mailbox(wake_id)
  `);

  // The background tasks conversations start (a subagent now; a background
  // command later, under its own kind): what the Background tasks list
  // shows and the per-conversation queue reads.
  // No CHECKs: SQLite cannot alter one, and a new kind brings statuses of its
  // own; the store's types decide what is written.
  db.exec(`
    create table if not exists background_tasks (
      id               text primary key,
      kind             text not null,
      parent_thread_id text not null,
      child_thread_id  text,
      type             text not null,
      title            text not null,
      task             text not null,
      status           text not null,
      stopped_by       text,
      reply            text,
      error            text,
      created_at       text not null,
      started_at       text,
      finished_at      text,
      -- Each change of a task takes the next number of all tasks (as a
      -- message has its seq): the client keeps the later copy, and reads what
      -- changed after the number its last read reflected.
      seq              integer not null default 0,
      -- A background command: its exit, where its output goes, and its
      -- process group (killed at a restart). It has no child thread.
      exit_code        integer,
      output_path      text,
      pid              integer,
      output_lines     integer
    )
  `);
  // The count is kept on its own, one row, so it never goes back when rows
  // go (a deleted conversation takes its tasks); it starts past the numbers
  // already written.
  db.exec(`create table if not exists background_task_seq (n integer not null)`);
  db.exec(`
    insert into background_task_seq (n)
      select coalesce((select max(seq) from background_tasks), 0)
       where not exists (select 1 from background_task_seq)
  `);
  db.exec(`
    create index if not exists idx_background_tasks_parent
      on background_tasks(parent_thread_id, created_at)
  `);
  db.exec(`
    create index if not exists idx_background_tasks_seq
      on background_tasks(seq)
  `);
  db.exec(`
    create unique index if not exists idx_background_tasks_child
      on background_tasks(child_thread_id)
  `);
  db.exec(`
    create index if not exists idx_background_tasks_open
      on background_tasks(status, created_at)
      where status in ('queued', 'running')
  `);

  createWorkItemsTable(db);
  db.exec(`
    create index if not exists idx_work_items_feature
      on work_items(feature_id)
  `);
}

function createWorkItemsTable(db: Database): void {
  db.exec(`
    create table if not exists work_items (
      id               text primary key,
      feature_id       text not null unique references features(id) on delete cascade,
      project_id       text not null,
      title            text not null,
      last_activity_at text not null,
      created_at       text not null,
      updated_at       text not null,
      -- The last state key a worker's wake end computed (the report gate),
      -- and the failure of its last wake until a later one finishes.
      reported_state   text,
      failed_at        text,
      failed_message   text,
      -- What ended the last wake: an error, or a stop (a repeated failing call).
      failed_kind      text
    )
  `);
}
