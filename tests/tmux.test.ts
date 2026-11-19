import { expect, test } from "bun:test";
import { buildTmuxSnapshot } from "../src/server/platform/tmux/tmux.js";
import type { RawTmuxState } from "../src/server/platform/tmux/tmux-types.js";

const analyzer = {
  getWindowAnalysis(window) {
    return window.windowAnalysis || {
      status: "unknown",
      taskTitle: `${window.sessionName}:${window.windowIndex}: ${window.windowName}`,
      panes: []
    };
  }
};

function baseAnalysis(status, title) {
  return {
    confidence: 0.8,
    status,
    summary: `${title} summary`,
    taskTitle: title
  };
}

test("buildTmuxSnapshot gives each pane its window's analysis of it, and the window its status and title", () => {
  // Raw fixtures carry the extra `windowAnalysis` field the fake analyzer
  // above reads back, and omit the pane fields the snapshot never uses.
  const snapshot = buildTmuxSnapshot({
    sessions: [
      { sessionName: "project-4", sessionAttached: 1, sessionWindows: 1 }
    ],
    windows: [
      {
        sessionName: "project-4",
        windowId: "@1",
        windowIndex: 1,
        windowName: "work-1",
        windowActive: true,
        windowPanes: 2,
        windowLayout: "",
        windowZoomed: false,
        windowAnalysis: {
          status: "done",
          taskTitle: "Whole window complete",
          panes: [
            { ...baseAnalysis("working", "Still running"), paneId: "%3", paneIndex: 3 },
            { ...baseAnalysis("done", "Finished task"), paneId: "%4", paneIndex: 4 }
          ]
        }
      }
    ],
    panes: [
      {
        sessionName: "project-4",
        windowId: "@1",
        paneId: "%3",
        paneIndex: 3,
        paneActive: false,
        currentCommand: "codex",
        currentPath: "/repo",
        changedAt: "2026-04-29T08:00:00.000Z",
        preview: "working preview",
        capture: "screen text"
      },
      {
        sessionName: "project-4",
        windowId: "@1",
        paneId: "%4",
        paneIndex: 4,
        paneActive: true,
        currentCommand: "zsh",
        currentPath: "/repo",
        preview: "done preview"
      }
    ]
  } as unknown as RawTmuxState, analyzer);

  const window = snapshot.sessions[0].windows[0];
  expect(window.aggregate).toEqual({ status: "done", title: "Whole window complete" });
  expect(window.panes.map((pane) => pane.analysis.status)).toEqual(["working", "done"]);
  expect(window.panes[0].changedAt).toBe("2026-04-29T08:00:00.000Z");
  expect(window.panes[0].preview).toBe("working preview");
  // The page gets each pane's analysis once, and no captured screen.
  expect(window.panes[0].capture).toBeUndefined();
  expect(Object.keys(window)).not.toContain("analysis");
  expect(Object.keys(snapshot).sort()).toEqual(["generatedAt", "sessions"]);
});

test("a pane its window's analysis leaves out reads as unknown, and the poll goes on", () => {
  const snapshot = buildTmuxSnapshot({
    sessions: [{ sessionName: "project-4", sessionAttached: 1, sessionWindows: 1 }],
    windows: [{
      sessionName: "project-4", windowId: "@1", windowIndex: 1, windowName: "work-1",
      windowActive: true, windowPanes: 1, windowLayout: "", windowZoomed: false,
      windowAnalysis: { status: "idle_shell", taskTitle: "work-1", panes: [] }
    }],
    panes: [{ sessionName: "project-4", windowId: "@1", paneId: "%9", paneIndex: 0, currentCommand: "zsh" }]
  } as unknown as RawTmuxState, analyzer);

  expect(snapshot.sessions[0].windows[0].panes[0].analysis).toMatchObject({ paneId: "%9", status: "unknown" });
});

test("buildTmuxSnapshot filters snapshot sessions to monitored windows", () => {
  const rawState = {
    sessions: [
      { sessionName: "project-4", sessionAttached: 1, sessionWindows: 2 }
    ],
    windows: [
      {
        sessionName: "project-4",
        windowId: "@1",
        windowIndex: 1,
        windowName: "work-1",
        windowActive: true,
        windowPanes: 1,
        windowLayout: "",
        windowZoomed: false,
        windowAnalysis: {
          ...baseAnalysis("working", "Monitored task"),
          panes: []
        }
      },
      {
        sessionName: "project-4",
        windowId: "@2",
        windowIndex: 2,
        windowName: "work-2",
        windowActive: false,
        windowPanes: 1,
        windowLayout: "",
        windowZoomed: false,
        windowAnalysis: {
          ...baseAnalysis("working", "Unmonitored task"),
          panes: []
        }
      }
    ],
    panes: [
      {
        sessionName: "project-4",
        windowId: "@1",
        paneId: "%1",
        paneIndex: 1,
        paneActive: true,
        currentCommand: "codex",
        currentPath: "/repo/one",
        changedAt: "2026-04-29T08:01:00.000Z",
        preview: ""
      },
      {
        sessionName: "project-4",
        windowId: "@2",
        paneId: "%2",
        paneIndex: 1,
        paneActive: true,
        currentCommand: "codex",
        currentPath: "/repo/two",
        preview: ""
      }
    ]
  } as unknown as RawTmuxState;

  const snapshot = buildTmuxSnapshot(rawState, analyzer, {
    monitorWindowKeys: new Set(["project-4:work-1"])
  });

  expect(snapshot.sessions[0].windows.length).toBe(1);
  expect(snapshot.sessions[0].windows[0].windowName).toBe("work-1");
});
