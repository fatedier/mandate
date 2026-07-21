import type { Database } from "bun:sqlite";
import { ensureColumn } from "../../platform/db/ensure-column.js";

export function initializeAgentSchema(db: Database): void {
  db.exec("pragma foreign_keys = on");
  db.exec(`
    create table if not exists agent_threads (
      id           text primary key,
      scope        text not null,
      scope_id     text,
      kind         text not null default 'main',
      parent_thread_id text,
      ephemeral    integer not null default 0,
      fork_context_start_seq integer,
      fork_context_end_seq integer,
      closed_at    text,
      created_at   text not null,
      updated_at   text not null,
      archived_at  text
    )
  `);

  ensureColumn(db, "agent_threads", "kind", "text not null default 'main'");
  ensureColumn(db, "agent_threads", "parent_thread_id", "text");
  ensureColumn(db, "agent_threads", "ephemeral", "integer not null default 0");
  ensureColumn(db, "agent_threads", "fork_context_start_seq", "integer");
  ensureColumn(db, "agent_threads", "fork_context_end_seq", "integer");
  ensureColumn(db, "agent_threads", "closed_at", "text");

  db.exec("drop index if exists idx_agent_threads_overview_main_uq");
  db.exec("drop index if exists idx_agent_threads_scope_active");
  db.exec("drop index if exists idx_agent_threads_overview_singleton");

  db.exec(`
    create unique index if not exists idx_agent_threads_scope_active
      on agent_threads(scope, scope_id)
      where kind = 'main' and scope_id is not null and archived_at is null
  `);
  db.exec(`
    create unique index if not exists idx_agent_threads_manager_singleton
      on agent_threads(scope)
      where kind = 'main' and scope = 'manager' and archived_at is null
  `);
  db.exec(`
    create unique index if not exists idx_agent_threads_open_side_parent
      on agent_threads(parent_thread_id)
      where kind = 'side' and closed_at is null
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
      metadata_json      text
    )
  `);
  db.exec(`
    create index if not exists idx_agent_wakes_thread
      on agent_wakes(thread_id, started_at desc)
  `);
  ensureColumn(db, "agent_wakes", "cancel_requested_at", "text");
  db.exec(`
    create table if not exists agent_side_transfers (
      id                   text primary key,
      source_thread_id     text not null,
      target_thread_id     text not null,
      client_request_id    text not null,
      content              text not null,
      status               text not null,
      delivered_message_id text,
      created_at           text not null,
      delivered_at         text,
      unique(source_thread_id, client_request_id)
    )
  `);
  db.exec(`
    create index if not exists idx_agent_side_transfers_target_status
      on agent_side_transfers(target_thread_id, status, created_at)
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
      timeout_ms  integer
    )
  `);

  // The table is new on this branch and has never shipped, but a development
  // database may already carry the version without timeout_ms — and
  // `create table if not exists` does not alter an existing table.
  // Nullable on purpose: a row written before this column existed has no
  // requested duration to record, and null is what tells the restore path to
  // reconstruct it from created_at/timeout_at rather than trusting a default
  // that was never asked for.
  ensureColumn(db, "agent_window_watches", "timeout_ms", "integer");

  db.exec(`
    create index if not exists idx_agent_window_watches_thread
      on agent_window_watches(thread_id)
  `);
  db.exec(`
    create table if not exists agent_tasks (
      id                   text primary key,
      feature_id           text not null,
      thread_id            text not null,
      source               text not null,
      channel              text not null,
      title                text not null,
      message              text not null,
      status               text not null,
      priority             integer not null default 0,
      caller_thread_id     text,
      created_by_thread_id text,
      last_note            text,
      created_at           text not null,
      updated_at           text not null,
      completed_at         text
    )
  `);
  db.exec(`
    create index if not exists idx_agent_tasks_thread_status
      on agent_tasks(thread_id, status, updated_at desc)
  `);
  db.exec(`
    create index if not exists idx_agent_tasks_caller
      on agent_tasks(caller_thread_id, updated_at desc)
      where caller_thread_id is not null
  `);
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
      event_kind           text not null default 'message',
      created_at           text not null,
      delivered_at         text
    )
  `);
  db.exec(`
    create index if not exists idx_agent_mailbox_thread_status
      on agent_mailbox(thread_id, status, created_at asc)
  `);
  db.exec(`
    create index if not exists idx_agent_mailbox_event_kind
      on agent_mailbox(thread_id, event_kind, status, created_at)
  `);

  db.exec(`
    create table if not exists feature_digests (
      feature_id               text primary key,
      summary                  text not null,
      decisions                text not null,
      open_questions           text not null,
      constraints              text not null,
      last_seq_covered         integer not null default 0,
      updated_by_thread_id     text not null,
      updated_at               text not null
    )
  `);

  // The change-brief experiment (2026-07) was removed; clean up its table
  // from databases that ran the interim builds.
  db.exec(`drop table if exists feature_change_briefs`);

  createWorkItemsTable(db);
  // Field-level provenance for `summary` only. Deliberately separate from
  // last_activity_at / updated_at, which every patch refreshes: those answer
  // "when did anything happen", these answer "when was this text written and
  // by whom". NULL on rows written before this column existed, and on rows
  // whose summary is still unset — both render as "no metadata", never as
  // "unknown".
  ensureColumn(db, "work_items", "summary_updated_at", "text");
  ensureColumn(db, "work_items", "summary_updated_by", "text");
  db.exec(`
    create index if not exists idx_work_items_needs_user
      on work_items(needs_user, last_activity_at desc)
  `);
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
      summary          text,
      canvas_id        text,
      needs_user       text check (needs_user in ('review', 'input') or needs_user is null),
      phase            text not null default 'design',
      phase_detail     text,
      summary_updated_at text,
      summary_updated_by text,
      last_activity_at text not null,
      created_at       text not null,
      updated_at       text not null
    )
  `);
}
