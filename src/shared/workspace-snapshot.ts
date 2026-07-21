import type {
  SnapshotSessionManifest, SnapshotVersion, WorkspaceSession, WorkspaceSnapshot, WorkspaceWindow
} from "./api/workspace-snapshot.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function snapshotVersion(snapshot: unknown): SnapshotVersion | null {
  const version = isRecord(snapshot) ? snapshot.snapshotVersion : null;
  return isRecord(version) && typeof version.epoch === "string" && version.epoch.length > 0
    && Number.isSafeInteger(version.revision) && Number(version.revision) > 0
    ? version as unknown as SnapshotVersion : null;
}

export function windowKey(sessionName: string, windowId: string): string {
  return JSON.stringify([sessionName, windowId]);
}

function uniqueNames(names: unknown[]): names is string[] {
  return names.every((name) => typeof name === "string" && name.length > 0)
    && new Set(names).size === names.length;
}

export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return false;
  if (!value.sessions.every((session) => isRecord(session) && Array.isArray(session.windows)
    && session.windows.every((window) => isRecord(window) && typeof window.windowId === "string")
    && uniqueNames(session.windows.map((window) => window.windowId)))) return false;
  return uniqueNames(value.sessions.map((session) => session.sessionName));
}

export function sessionManifest(snapshot: WorkspaceSnapshot): SnapshotSessionManifest[] {
  return snapshot.sessions.map(({ windows, ...session }) => ({
    ...session, windowIds: windows.map((window) => window.windowId)
  }));
}

export function snapshotWindows(snapshot: WorkspaceSnapshot): Map<string, WorkspaceWindow> {
  return new Map(snapshot.sessions.flatMap((session) => session.windows.map((window) => (
    [windowKey(session.sessionName, window.windowId), window] as const
  ))));
}

/** Baseline belongs to this stream, independently of HTTP writes to UI state. */
export class WorkspaceSnapshotDecoder {
  private snapshot: WorkspaceSnapshot | null = null;
  private revision = 0;

  reset(): void { this.snapshot = null; this.revision = 0; }

  full(value: unknown): WorkspaceSnapshot {
    if (!isRecord(value) || !Number.isSafeInteger(value.revision)
      || Number(value.revision) <= this.revision || !isWorkspaceSnapshot(value.snapshot)) {
      throw new Error("Invalid workspace snapshot baseline");
    }
    this.snapshot = value.snapshot;
    this.revision = Number(value.revision);
    return this.snapshot;
  }

  patch(value: unknown): WorkspaceSnapshot {
    const previous = this.snapshot;
    if (!previous || !isRecord(value) || value.baseRevision !== this.revision
      || value.revision !== this.revision + 1) throw new Error("Workspace snapshot revision mismatch");
    const { fields = {}, removedFields = [], sessions, windows = [] } = value;
    if ((sessions !== undefined && !Array.isArray(sessions))
      || !isRecord(fields) || "sessions" in fields || !Array.isArray(removedFields)
      || !uniqueNames(removedFields) || removedFields.some((key) => key === "sessions" || key in fields)
      || !Array.isArray(windows)) throw new Error("Invalid workspace snapshot patch");

    const manifest = sessions ?? sessionManifest(previous);
    if (!Array.isArray(manifest) || !manifest.every((session) => isRecord(session)
      && !("windows" in session) && Array.isArray(session.windowIds) && uniqueNames(session.windowIds))
      || !uniqueNames(manifest.map((session) => session.sessionName))) {
      throw new Error("Invalid workspace session manifest");
    }
    const members = new Set<string>(manifest.flatMap((session) => session.windowIds.map((id: string) => (
      windowKey(session.sessionName, id)
    ))));
    const byWindow = snapshotWindows(previous);
    const updated = new Set<string>();
    for (const entry of windows) {
      if (!isRecord(entry) || typeof entry.sessionName !== "string" || !isRecord(entry.window)
        || typeof entry.window.windowId !== "string") throw new Error("Invalid workspace window update");
      const key = windowKey(entry.sessionName, entry.window.windowId);
      if (!members.has(key) || updated.has(key)) throw new Error("Unexpected workspace window update");
      updated.add(key);
      byWindow.set(key, entry.window as WorkspaceWindow);
    }
    const bySession = new Map(previous.sessions.map((session) => [session.sessionName, session]));
    const nextSessions: WorkspaceSession[] = manifest.map(({ windowIds, ...metadata }) => {
      const sessionWindows = windowIds.map((id: string) => {
        const window = byWindow.get(windowKey(metadata.sessionName, id));
        if (!window) throw new Error("Missing workspace window baseline");
        return window;
      });
      const old = bySession.get(metadata.sessionName);
      if (sessions === undefined && old && sessionWindows.length === old.windows.length
        && sessionWindows.every((window: WorkspaceWindow, index: number) => window === old.windows[index])) return old;
      return { ...metadata, windows: sessionWindows } as WorkspaceSession;
    });
    const next: WorkspaceSnapshot = { ...previous, ...fields, sessions: nextSessions };
    for (const key of removedFields) delete next[key];
    this.snapshot = next;
    this.revision = Number(value.revision);
    return next;
  }
}
