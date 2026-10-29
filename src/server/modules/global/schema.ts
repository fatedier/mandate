import type { Database } from "bun:sqlite";

/** One open global-agent thread. The scope index
 *  (`idx_agent_threads_scope_active`) cannot hold it: it only covers rows
 *  with a scope_id, and this thread has none. */
export function initializeGlobalAgentSchema(db: Database): void {
  db.exec(`
    create unique index if not exists idx_agent_threads_global_singleton
      on agent_threads(scope)
      where scope = 'global' and archived_at is null
  `);
  db.exec(`
    create table if not exists global_handoffs (
      id                text primary key,
      global_thread_id  text not null,
      kind              text not null,
      state             text not null,
      text              text not null,
      spoken            integer not null default 0,
      feature_id        text,
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
  db.exec("create index if not exists idx_global_handoffs_target on global_handoffs(target_thread_id, state)");
  db.exec("create index if not exists idx_global_handoffs_created on global_handoffs(created_at)");
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
