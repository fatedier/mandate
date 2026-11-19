import type { Database } from "bun:sqlite";

/** The owner's task board. No CHECK constraints: SQLite cannot alter one later,
 *  and the service is the only writer. A link's thread title is kept as it was
 *  when linked, for a thread that is gone since. */
export function initializeTaskBoardSchema(db: Database): void {
  db.exec(`
    create table if not exists task_board_tasks (
      id           text primary key,
      title        text not null,
      description  text not null default '',
      status       text not null,
      due_date     text,
      due_time     text,
      result       text,
      result_at    text,
      created_at   text not null,
      created_by   text not null,
      updated_at   text not null,
      deleted_at   text
    )
  `);
  db.exec(`
    create table if not exists task_board_threads (
      task_id      text not null,
      thread_id    text not null,
      linked_at    text not null,
      primary key (task_id, thread_id)
    )
  `);
  db.exec(`create index if not exists idx_task_board_threads_thread on task_board_threads (thread_id)`);
  db.exec(`
    create table if not exists task_board_entries (
      id            text primary key,
      task_id       text not null,
      seq           integer not null,
      kind          text not null,
      by_actor      text not null,
      text          text not null default '',
      status        text,
      thread_id     text,
      thread_title  text,
      new_thread    integer not null default 0,
      created_at    text not null
    )
  `);
  db.exec(`create index if not exists idx_task_board_entries_task on task_board_entries (task_id, seq)`);
  db.exec(`
    create table if not exists task_board_labels (
      task_id   text not null,
      name      text not null,
      name_key  text not null,
      by_actor  text not null,
      added_at  text not null,
      primary key (task_id, name_key)
    )
  `);
  db.exec(`create index if not exists idx_task_board_labels_key on task_board_labels (name_key)`);
  db.exec(`
    create table if not exists task_board_state (
      key    text primary key,
      value  text not null
    )
  `);
}
