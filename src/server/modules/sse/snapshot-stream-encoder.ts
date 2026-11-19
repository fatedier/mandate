import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { SnapshotPatchDto } from "../../../shared/api/workspace-snapshot.js";
import { isWorkspaceSnapshot, sessionManifest, snapshotWindows, windowKey } from "../../../shared/workspace-snapshot.js";

interface Baseline {
  fields: Map<string, string>;
  sessions: string;
  windows: Map<string, string>;
}

/** Compare against exactly what this connection received, not the last poll. */
export class SnapshotStreamEncoder {
  private baseline: Baseline | null = null;
  private revision = 0;

  encode(snapshot: unknown): { event: string; data: string } {
    if (!isWorkspaceSnapshot(snapshot)) {
      this.baseline = null;
      return { event: SSE_EVENTS.snapshot, data: JSON.stringify(snapshot) };
    }
    const revision = ++this.revision;
    const full = { event: SSE_EVENTS.snapshotFull, data: JSON.stringify({ revision, snapshot }) };
    const manifest = sessionManifest(snapshot);
    const windows = snapshotWindows(snapshot);
    // Serialized comparisons survive mutation of objects held by producers.
    const next: Baseline = {
      fields: new Map(Object.entries(snapshot).filter(([key, value]) => key !== "sessions" && value !== undefined)
        .map(([key, value]) => [key, JSON.stringify(value)])),
      sessions: JSON.stringify(manifest),
      windows: new Map([...windows].map(([key, window]) => [key, JSON.stringify(window)]))
    };
    const previous = this.baseline;
    this.baseline = next;
    if (!previous) return full;

    const patch: SnapshotPatchDto = { baseRevision: revision - 1, revision };
    const fields = Object.fromEntries([...next.fields].filter(([key, json]) => previous.fields.get(key) !== json)
      .map(([key]) => [key, snapshot[key]]));
    if (Object.keys(fields).length) patch.fields = fields;
    const removed = [...previous.fields.keys()].filter((key) => !next.fields.has(key));
    if (removed.length) patch.removedFields = removed;
    if (next.sessions !== previous.sessions) patch.sessions = manifest;
    const changed = snapshot.sessions.flatMap((session) => session.windows
      .filter((window) => previous.windows.get(windowKey(session.sessionName, window.windowId))
        !== next.windows.get(windowKey(session.sessionName, window.windowId)))
      .map((window) => ({ sessionName: session.sessionName, window })));
    if (changed.length) patch.windows = changed;
    const data = JSON.stringify(patch);
    return Buffer.byteLength(data) + SSE_EVENTS.snapshotPatch.length < Buffer.byteLength(full.data) + full.event.length
      ? { event: SSE_EVENTS.snapshotPatch, data } : full;
  }
}
