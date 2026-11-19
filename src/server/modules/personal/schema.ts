import type { Database } from "bun:sqlite";

/** One open personal agent thread. The scope index
 *  (`idx_agent_threads_scope_active`) cannot hold it: it only covers rows
 *  with a scope_id, and this thread has none. */
export function initializePersonalAgentSchema(db: Database): void {
  db.exec(`
    create unique index if not exists idx_agent_threads_personal_singleton
      on agent_threads(scope)
      where scope = 'personal' and archived_at is null
  `);
  db.exec(`
    create table if not exists personal_handoffs (
      id                text primary key,
      personal_thread_id  text not null,
      kind              text not null,
      state             text not null,
      text              text not null,
      spoken            integer not null default 0,
      worker_id        text,
      target_thread_id  text,
      new_thread_title  text,
      message_id        text,
      message_seq       integer,
      reply             text,
      reason            text,
      created_at        text not null,
      updated_at        text not null,
      replied_at        text,
      -- How the target of a wait stopped.
      stop_state        text
    )
  `);
  db.exec("create index if not exists idx_personal_handoffs_target on personal_handoffs(target_thread_id, state)");
  // The open handoffs, read at every step of the personal agent: a few among every
  // handoff there ever was.
  db.exec("create index if not exists idx_personal_handoffs_state on personal_handoffs(state, created_at)");
  // The manager threads opened beside the personal agent, as tabs in its right panel.
  db.exec(`
    create table if not exists personal_thread_tabs (
      thread_id   text primary key,
      created_at  text not null
    )
  `);
  // The user's direct chats with manager threads told to the personal agent:
  // the seq of the last of their words each told (direct-chats.ts).
  db.exec(`
    create table if not exists personal_direct_chats (
      thread_id  text primary key,
      told_seq   integer not null,
      told_at    text not null
    )
  `);
  // The manager stop check's verdict on each manager thread's latest reply it judged.
  db.exec(`
    create table if not exists manager_stop_checks (
      thread_id  text primary key,
      reply_seq  integer not null,
      outcome    text not null check (outcome in ('decision', 'result', 'nothing')),
      judged_at  text not null
    )
  `);
}
