import type { Database } from "bun:sqlite";

export function initializeSessionsSchema(db: Database): void {
  // The panes the user pinned to the Terminals page, named by id and pid:
  // tmux gives the same ids out again after its server restarts. `position`
  // is the order they were dragged into; a pin with none (made before the
  // column) follows the placed ones, in the order made.
  db.exec(`
    create table if not exists terminal_pins (
      pane_id    text primary key,
      pane_pid   integer not null,
      pinned_at  text not null,
      position   integer
    )
  `);
}
