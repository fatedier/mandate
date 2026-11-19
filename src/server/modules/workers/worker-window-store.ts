import type { Database } from "bun:sqlite";

export class WorkerWindowStore {
  constructor(private readonly db: Database) {}

  listActiveWindowKeys(): Set<string> {
    const rows = this.db
      .prepare(
        `
      select p.tmux_session_name as session_name, wk.tmux_window_name as window_name
      from workers wk
      join projects p on p.id = wk.project_id
      where wk.archived_at is null and p.archived_at is null
    `
      )
      .all() as Array<{ session_name: string; window_name: string }>;
    return new Set(rows.map((r) => `${r.session_name}:${r.window_name}`));
  }
}
