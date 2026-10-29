export interface SnapshotVersion {
  epoch: string;
  revision: number;
}

// Only the fields needed to identify and merge snapshots belong to the wire
// protocol. Window and pane contents remain the existing snapshot DTOs.
export interface WorkspaceWindow {
  windowId: string;
  [key: string]: unknown;
}

export interface WorkspaceSession {
  sessionName: string;
  windows: WorkspaceWindow[];
  [key: string]: unknown;
}

export interface WorkspaceSnapshot {
  sessions: WorkspaceSession[];
  [key: string]: unknown;
}

export interface SnapshotSessionManifest {
  sessionName: string;
  windowIds: string[];
  [key: string]: unknown;
}

export interface SnapshotFullDto {
  revision: number;
  snapshot: WorkspaceSnapshot;
}

export interface SnapshotPatchDto {
  baseRevision: number;
  revision: number;
  fields?: Record<string, unknown>;
  removedFields?: string[];
  sessions?: SnapshotSessionManifest[];
  windows?: Array<{ sessionName: string; window: WorkspaceWindow }>;
}
