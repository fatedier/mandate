import type { Database } from "bun:sqlite";

/** A thread notice's question id, as the index below keeps it. Guarded: a
 *  notice whose content is not JSON (none should be) must neither fail the
 *  index at start nor its own write. A query uses it word for word. */
export const NOTICE_QUESTION_ID_SQL = "iif(json_valid(content), json_extract(content, '$.metadata.threadNotice.question.id'), null)";

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
  // The open manager threads, in the order they were made: subagent and
  // archived threads outnumber them many times over.
  db.exec(`
    create index if not exists idx_agent_threads_open_managers
      on agent_threads(created_at)
      where scope = 'manager' and archived_at is null
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
  // A message's seq is its place in its thread, so the database refuses a
  // second row at one. Unique, this index looks as good to SQLite (planning
  // without statistics) as a partial index on (thread_id, seq), and which
  // wins can follow the order the indexes were made: a read meant for a
  // partial index names it (`indexed by`).
  db.exec("create unique index if not exists idx_agent_messages_thread_seq on agent_messages(thread_id, seq)");
  // A thread's summaries, newest first, without walking its other rows: every
  // step reads the latest one, and a long thread holds tens of thousands.
  db.exec(`
    create index if not exists idx_agent_messages_compression
      on agent_messages(thread_id, seq, created_at, id)
      where source = 'compression'
  `);
  // A turn's rows in order: its newest reply is read from the newest down
  // (latestAssistantTextOfWake), never all of a long turn sorted. It covers
  // every lookup the wake_id-only index served, which goes.
  db.exec(`
    create index if not exists idx_agent_messages_wake_seq
      on agent_messages(wake_id, seq)
  `);
  // The threads holding runtime context, which the hourly retention pass
  // walks: a few thousand rows among every message there is.
  db.exec(`
    create index if not exists idx_agent_messages_runtime_context
      on agent_messages(thread_id) where source = 'runtime-context'
  `);
  // The user's own messages, typed or spoken, newest first: the dream's tick
  // asks when the user last wrote, one row among every message there is.
  db.exec(`
    create index if not exists idx_agent_messages_human_input
      on agent_messages(created_at) where role = 'user' and source in ('user', 'voice')
  `);
  // The same messages by thread: a thread's latest one is read at each turn,
  // and in a thread where the user never wrote, finding none would walk it all.
  db.exec(`
    create index if not exists idx_agent_messages_person
      on agent_messages(thread_id, seq) where role = 'user' and source in ('user', 'voice')
  `);
  // Only failure rows: a wake's ending is read on every thread list.
  db.exec(`
    create index if not exists idx_agent_messages_wake_failure
      on agent_messages(wake_id, seq) where source = 'wake-failure'
  `);
  // The notice that told the personal agent of a question, by the question's id:
  // looked for when the question is settled, among every message of the personal
  // agent's thread, which only grows.
  db.exec(`
    create index if not exists idx_agent_messages_notice_question
      on agent_messages(${NOTICE_QUESTION_ID_SQL}) where source = 'thread-notice'
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
  // The running wakes alone: whether a thread runs is asked for every thread
  // on each status refresh, and is mostly "no", which otherwise reads every
  // wake the thread ever had.
  db.exec(`
    create index if not exists idx_agent_wakes_running
      on agent_wakes(thread_id, started_at) where status = 'running'
  `);
  // A thread's context figure: its last measured turn, read backwards from
  // the end (getContextUsage) instead of sorting every turn the thread had.
  db.exec(`
    create index if not exists idx_agent_wakes_context_usage
      on agent_wakes(thread_id, last_input_at, started_at)
      where last_input_tokens is not null
  `);
  // A conversation's version: moved by every change to one of its stored
  // messages after it was written (an update, a delete, a row slipped in below
  // its newest), and by a change to what its messages show of their turn (a
  // turn ending stopped). A reader that keeps a conversation in memory finds
  // new rows by seq and reads afresh when this moves, so it never has to be
  // told by the code that changed something. Rows are never deleted: a missing
  // row reads as 0, so a deleted one would let a copy read at 0 pass again.
  db.exec(`
    create table if not exists agent_message_versions (
      thread_id text primary key,
      version   integer not null
    )
  `);
  const bump = (thread: string) => `
      insert into agent_message_versions (thread_id, version) values (${thread}, 1)
        on conflict(thread_id) do update set version = version + 1;`;
  db.exec(`
    create trigger if not exists agent_messages_version_update
    after update on agent_messages
    begin${bump("old.thread_id")}
      insert into agent_message_versions (thread_id, version)
        select new.thread_id, 1 where new.thread_id is not old.thread_id
        on conflict(thread_id) do update set version = version + 1;
    end
  `);
  db.exec(`
    create trigger if not exists agent_messages_version_delete
    after delete on agent_messages
    begin${bump("old.thread_id")}
    end
  `);
  // Through the (thread_id, seq) index: an append, whose seq is the thread's
  // newest, finds only itself.
  db.exec(`
    create trigger if not exists agent_messages_version_insert
    after insert on agent_messages
    when exists (select 1 from agent_messages where thread_id = new.thread_id and seq >= new.seq and id != new.id)
    begin${bump("new.thread_id")}
    end
  `);
  // The labels of manager threads (ThreadLabels): a name once per thread
  // whatever its case, with who put it on. Found by name across threads for
  // the spelling already in use.
  db.exec(`
    create table if not exists thread_labels (
      thread_id text not null,
      name      text not null,
      name_key  text not null,
      by_actor  text not null,
      added_at  text not null,
      primary key (thread_id, name_key)
    )
  `);
  db.exec(`create index if not exists idx_thread_labels_key on thread_labels (name_key)`);
  // A thread's seq never goes back. A message deleted from the end of its
  // thread would hand its seq to the next one appended, and everything that
  // keeps its place by seq (a page's catch-up, a read mark) would pass it by.
  // The highest seq a deleted message had (AgentStore.removeMessages); the
  // next seq is above it and above every stored row.
  db.exec(`
    create table if not exists agent_message_seq_floors (
      thread_id text primary key,
      seq       integer not null
    )
  `);
  // The messages a person deleted, by id and nothing else of them: a page
  // whose stream was down when one went is told at its next read
  // (MessageDeletion.deletedIn).
  db.exec(`
    create table if not exists agent_message_deletions (
      message_id text primary key,
      thread_id  text not null,
      deleted_at text not null
    )
  `);
  db.exec(`create index if not exists idx_agent_message_deletions_thread on agent_message_deletions(thread_id, deleted_at)`);
  // What a message shows of its turn: the reason, metadata, start, and
  // whether it was stopped. Step counts, token figures and an ordinary end
  // change none of it.
  db.exec(`
    create trigger if not exists agent_wakes_version_update
    after update of status, reason, metadata_json, started_at on agent_wakes
    when (new.status = 'canceled') is not (old.status = 'canceled')
      or new.reason is not old.reason
      or new.metadata_json is not old.metadata_json
      or new.started_at is not old.started_at
    begin${bump("new.thread_id")}
    end
  `);
  db.exec(`
    create trigger if not exists agent_wakes_version_delete
    after delete on agent_wakes
    begin${bump("old.thread_id")}
    end
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
  // A thread's pending alarms: a few among every alarm it ever set.
  db.exec(`
    create index if not exists idx_agent_alarms_thread_pending
      on agent_alarms(thread_id, fire_at) where status = 'pending'
  `);
  db.exec(`
    create table if not exists agent_pane_monitors (
      id          text primary key,
      thread_id   text not null,
      window_key  text not null,
      pane_id     text not null,
      note        text not null default '',
      created_at  text not null,
      timeout_at  text not null,
      timeout_ms  integer,
      -- The pane's name when the monitor was registered: its event and its
      -- waiting line name the pane even where the chat has not loaded the call
      -- that named it. Null for a pane with no name.
      pane_name   text
    )
  `);

  db.exec(`
    create index if not exists idx_agent_pane_monitors_thread
      on agent_pane_monitors(thread_id)
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
  // The replies the user opened in a thread's right panel, with the text as
  // it was when opened (reply-tabs.ts). One per reply; they go with their thread.
  db.exec(`
    create table if not exists agent_reply_tabs (
      id         text primary key,
      thread_id  text not null,
      message_id text not null,
      text       text not null,
      replied_at text not null,
      created_at text not null,
      unique (thread_id, message_id)
    )
  `);
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

  // The background tasks conversations start (a subagent or a background
  // command, each under its own kind): what the Background tasks list
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
  // go (a deleted conversation takes its tasks).
  db.exec(`create table if not exists background_task_seq (n integer not null)`);
  db.exec(`insert into background_task_seq (n) select 0 where not exists (select 1 from background_task_seq)`);
  db.exec(`
    create index if not exists idx_background_tasks_parent
      on background_tasks(parent_thread_id, created_at)
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
  // What runs, and what waits, each on its own: a query asking for one
  // status cannot use the index above (SQLite matches its condition as
  // written), and the reconcile tick asks every 30 seconds.
  db.exec(`
    create index if not exists idx_background_tasks_running
      on background_tasks(parent_thread_id) where status = 'running'
  `);
  db.exec(`
    create index if not exists idx_background_tasks_queued
      on background_tasks(created_at) where status = 'queued'
  `);

  createWorkItemsTable(db);
}

function createWorkItemsTable(db: Database): void {
  db.exec(`
    create table if not exists work_items (
      id               text primary key,
      worker_id       text not null unique references workers(id) on delete cascade,
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
