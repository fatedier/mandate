import type { Database } from "bun:sqlite";
import type { RawTmuxPane, RawTmuxState } from "../../platform/tmux/tmux-types.js";

export interface PaneMetadata {
  paneId: string;
  featureId: string | null;
  sessionName: string | null;
  windowName: string | null;
  name: string;
  description: string;
  createdByThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaneMetadataUpsertInput {
  paneId: string;
  featureId?: string | null;
  sessionName?: string | null;
  windowName?: string | null;
  name?: string | null;
  description?: string | null;
  createdByThreadId?: string | null;
}

interface RawPaneMetadata {
  pane_id: string;
  feature_id: string | null;
  session_name: string | null;
  window_name: string | null;
  name: string;
  description: string;
  created_by_thread_id: string | null;
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
    const featureId = normalizeOptional(input.featureId) ?? existing?.featureId ?? null;
    const sessionName = normalizeOptional(input.sessionName) ?? existing?.sessionName ?? null;
    const windowName = normalizeOptional(input.windowName) ?? existing?.windowName ?? null;
    const createdByThreadId = normalizeOptional(input.createdByThreadId) ?? existing?.createdByThreadId ?? null;

    this.db.prepare(
      `insert into pane_metadata
        (pane_id, feature_id, session_name, window_name, name, description,
         created_by_thread_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(pane_id) do update set
         feature_id = excluded.feature_id,
         session_name = excluded.session_name,
         window_name = excluded.window_name,
         name = excluded.name,
         description = excluded.description,
         created_by_thread_id = coalesce(pane_metadata.created_by_thread_id, excluded.created_by_thread_id),
         updated_at = excluded.updated_at`
    ).run(
      paneId,
      featureId,
      sessionName,
      windowName,
      name,
      description,
      createdByThreadId,
      existing?.createdAt ?? now,
      now
    );
    return this.get(paneId)!;
  }

  get(paneId: string): PaneMetadata | null {
    const row = this.db.prepare(
      `select pane_id, feature_id, session_name, window_name, name, description,
              created_by_thread_id, created_at, updated_at
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
    featureId: row.feature_id,
    sessionName: row.session_name,
    windowName: row.window_name,
    name: row.name,
    description: row.description,
    createdByThreadId: row.created_by_thread_id,
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
