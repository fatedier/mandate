import type { Database } from "bun:sqlite";
import type { RawTmuxPane, RawTmuxState } from "../../platform/tmux/tmux-types.js";

interface PaneMetadata {
  paneId: string;
  workerId: string | null;
  sessionName: string | null;
  windowName: string | null;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface PaneMetadataUpsertInput {
  paneId: string;
  workerId?: string | null;
  sessionName?: string | null;
  windowName?: string | null;
  name?: string | null;
  description?: string | null;
}

interface RawPaneMetadata {
  pane_id: string;
  worker_id: string | null;
  session_name: string | null;
  window_name: string | null;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export class PaneMetadataStore {
  constructor(private readonly db: Database) {}

  upsert(input: PaneMetadataUpsertInput): PaneMetadata {
    const paneId = normalizeRequired(input.paneId, "paneId");
    const existing = this.get(paneId);
    const now = new Date().toISOString();
    const name = normalizeOptional(input.name) ?? existing?.name ?? "";
    const description = normalizeOptional(input.description) ?? existing?.description ?? "";
    const workerId = normalizeOptional(input.workerId) ?? existing?.workerId ?? null;
    const sessionName = normalizeOptional(input.sessionName) ?? existing?.sessionName ?? null;
    const windowName = normalizeOptional(input.windowName) ?? existing?.windowName ?? null;

    this.db.prepare(
      `insert into pane_metadata
        (pane_id, worker_id, session_name, window_name, name, description,
         created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(pane_id) do update set
         worker_id = excluded.worker_id,
         session_name = excluded.session_name,
         window_name = excluded.window_name,
         name = excluded.name,
         description = excluded.description,
         updated_at = excluded.updated_at`
    ).run(
      paneId,
      workerId,
      sessionName,
      windowName,
      name,
      description,
      existing?.createdAt ?? now,
      now
    );
    return this.get(paneId)!;
  }

  get(paneId: string): PaneMetadata | null {
    const row = this.db.prepare(
      `select pane_id, worker_id, session_name, window_name, name, description,
              created_at, updated_at
       from pane_metadata
       where pane_id = ?`
    ).get(normalizeRequired(paneId, "paneId")) as RawPaneMetadata | undefined;
    return row ? toPaneMetadata(row) : null;
  }

  delete(paneId: string): void {
    this.db.prepare(`delete from pane_metadata where pane_id = ?`)
      .run(normalizeRequired(paneId, "paneId"));
  }

  enrichRawState(raw: RawTmuxState): RawTmuxState {
    const panes = raw.panes.map((pane) => {
      const metadata = this.metadataForPane(pane);
      return metadata
        ? {
            ...pane,
            metadata: {
              name: metadata.name,
              description: metadata.description,
              updatedAt: metadata.updatedAt
            }
          }
        : pane;
    });
    return { ...raw, panes };
  }

  metadataForPane(pane: Pick<RawTmuxPane, "paneId" | "sessionName" | "windowName">): PaneMetadata | null {
    const metadata = this.get(pane.paneId);
    if (!metadata) return null;
    if (metadata.sessionName && metadata.sessionName !== pane.sessionName) return null;
    if (metadata.windowName && metadata.windowName !== pane.windowName) return null;
    return metadata;
  }
}

function toPaneMetadata(row: RawPaneMetadata): PaneMetadata {
  return {
    paneId: row.pane_id,
    workerId: row.worker_id,
    sessionName: row.session_name,
    windowName: row.window_name,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeRequired(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : "";
}
