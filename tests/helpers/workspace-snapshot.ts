import type { WorkspaceSnapshot } from "../../src/shared/api/workspace-snapshot.js";

export function workspaceSnapshot(revision = 1): WorkspaceSnapshot {
  return {
    snapshotVersion: { epoch: "fixture-server", revision }, generatedAt: `poll-${revision}`,
    sessions: ["alpha", "beta"].map((sessionName) => ({
      sessionName, sessionAttached: 0, sessionWindows: 3, activeClient: null,
      windows: Array.from({ length: 3 }, (_, index) => ({
        sessionName, windowId: `@${index}`, windowIndex: index, windowName: `worker-${index}`,
        windowActive: index === 0, aggregate: { status: "working" },
        panes: [{ paneId: `%${index}`, paneIndex: 0, preview: `${sessionName}-${index} output\n`.repeat(500) }]
      }))
    })),
    clients: [], counts: { totalWindows: 6, working: 6 }
  };
}
