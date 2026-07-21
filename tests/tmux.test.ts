import { expect, test } from "bun:test";
import { buildTmuxSnapshot } from "../src/server/platform/tmux/tmux.js";

const analyzer = {
  getPaneAnalysis(pane) {
    return pane.analysis;
  },
  getWindowAnalysis(window) {
    return window.windowAnalysis || {
      status: "unknown",
      confidence: 0.1,
      pending: false,
      taskTitle: `${window.sessionName}:${window.windowIndex}: ${window.windowName}`,
      summary: "",
      suggestedAction: "",
      urgency: "low",
      primaryPaneId: window.panes?.[0]?.paneId || "",
      panes: []
    };
  }
};

function baseAnalysis(status, title) {
  return {
    confidence: 0.8,
    pending: false,
    status,
    suggestedAction: "",
    summary: `${title} summary`,
    taskTitle: title,
    urgency: "low"
  };
}

test("buildTmuxSnapshot uses window analysis for aggregate state", () => {
  const snapshot = buildTmuxSnapshot({
    clients: [],
    sessions: [
      { sessionName: "nova", sessionAttached: 1, sessionWindows: 1 }
    ],
    windows: [
      {
        sessionName: "nova",
        windowId: "@1",
        windowIndex: 1,
        windowName: "work-1",
        windowActive: true,
        windowPanes: 2,
        windowLayout: "",
        windowZoomed: false,
        windowAnalysis: {
          status: "done",
          confidence: 0.9,
          pending: false,
          taskTitle: "Whole window complete",
          summary: "The window task is complete.",
          suggestedAction: "",
          urgency: "low",
          primaryPaneId: "%4",
          panes: [
            baseAnalysis("working", "Still running"),
            { ...baseAnalysis("done", "Finished task"), paneId: "%4", paneIndex: 4 }
          ]
        }
      }
    ],
    panes: [
      {
        sessionName: "nova",
        windowId: "@1",
        paneId: "%3",
        paneIndex: 3,
        paneActive: false,
        currentCommand: "codex",
        currentPath: "/repo",
        changedAt: "2026-04-29T08:00:00.000Z",
        preview: "working preview",
        analysis: baseAnalysis("working", "Still running")
      },
      {
        sessionName: "nova",
        windowId: "@1",
        paneId: "%4",
        paneIndex: 4,
        paneActive: true,
        currentCommand: "zsh",
        currentPath: "/repo",
        preview: "done preview",
        analysis: baseAnalysis("done", "Finished task")
      }
    ]
  }, analyzer);

  const window = snapshot.sessions[0].windows[0];
  expect(window.aggregate.status).toBe("done");
  expect(window.aggregate.paneId).toBe("%4");
  expect(window.aggregate.title).toBe("Whole window complete");
  expect(window.panes[1].analysis.status).toBe("done");
  expect(window.panes[0].changedAt).toBe("2026-04-29T08:00:00.000Z");
  expect(snapshot.counts.working).toBe(0);
  expect(snapshot.counts.done).toBe(1);
});

test("buildTmuxSnapshot filters snapshot sessions to monitored windows", () => {
  const rawState = {
    clients: [],
    sessions: [
      { sessionName: "nova", sessionAttached: 1, sessionWindows: 2 }
    ],
    windows: [
      {
        sessionName: "nova",
        windowId: "@1",
        windowIndex: 1,
        windowName: "work-1",
        windowActive: true,
        windowPanes: 1,
        windowLayout: "",
        windowZoomed: false,
        windowAnalysis: {
          ...baseAnalysis("working", "Monitored task"),
          primaryPaneId: "%1",
          panes: []
        }
      },
      {
        sessionName: "nova",
        windowId: "@2",
        windowIndex: 2,
        windowName: "work-2",
        windowActive: false,
        windowPanes: 1,
        windowLayout: "",
        windowZoomed: false,
        windowAnalysis: {
          ...baseAnalysis("working", "Unmonitored task"),
          primaryPaneId: "%2",
          panes: []
        }
      }
    ],
    panes: [
      {
        sessionName: "nova",
        windowId: "@1",
        paneId: "%1",
        paneIndex: 1,
        paneActive: true,
        currentCommand: "codex",
        currentPath: "/repo/one",
        changedAt: "2026-04-29T08:01:00.000Z",
        preview: "",
        analysis: baseAnalysis("working", "Monitored task")
      },
      {
        sessionName: "nova",
        windowId: "@2",
        paneId: "%2",
        paneIndex: 1,
        paneActive: true,
        currentCommand: "codex",
        currentPath: "/repo/two",
        preview: "",
        analysis: baseAnalysis("working", "Unmonitored task")
      }
    ]
  };

  const snapshot = buildTmuxSnapshot(rawState, analyzer, {
    monitorWindowKeys: new Set(["nova:work-1"])
  });

  expect(snapshot.sessions[0].windows.length).toBe(1);
  expect(snapshot.sessions[0].windows[0].windowName).toBe("work-1");
  expect(snapshot.counts.totalWindows).toBe(1);
});
