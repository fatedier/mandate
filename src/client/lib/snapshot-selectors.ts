import type { SnapshotWindow, TypedSnapshot } from "./snapshot-types";

/** Undefined means the initial snapshot is pending; null means it has no match. */
export function selectSnapshotWindow(
  snapshot: TypedSnapshot | null,
  sessionName: string,
  windowName: string
): SnapshotWindow | null | undefined {
  if (!snapshot) return undefined;
  for (const session of snapshot.sessions ?? []) {
    if (session.sessionName !== sessionName) continue;
    for (const window of session.windows ?? []) {
      if (window.windowName === windowName) return window;
    }
  }
  return null;
}
