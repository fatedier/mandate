import { expect, test } from "bun:test";
import { buildPaneLookup, PaneService } from "../src/server/modules/panes/pane-service.js";
import { buildSessionsDto } from "../src/server/modules/sessions/session-service.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";
import type { RawTmuxState } from "../src/server/platform/tmux/tmux-types.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("buildSessionsDto enriches tmux sessions with ownership and raw panes", () => {
  const raw = rawState();
  const sessions = buildSessionsDto(
    [
      { name: "md-app", windows: ["main"] },
      { name: "external", windows: ["shell"] }
    ],
    raw,
    new Map([["md-app", { id: "p1", name: "App" }]])
  );

  expect(sessions[0]).toMatchObject({
    name: "md-app",
    ownership: "managed",
    projectId: "p1",
    projectName: "App",
    windows: [{
      name: "main",
      windowId: "@1",
      index: 1,
      active: true,
      panes: [{
        paneId: "%1",
        index: 0,
        active: true,
        currentCommand: "zsh",
        currentPath: "/tmp/app"
      }]
    }]
  });
  expect(sessions[1]).toMatchObject({
    name: "external",
    ownership: "unmanaged",
    projectId: null,
    projectName: null
  });
});

test("buildPaneLookup maps raw pane geometry and owning project id", () => {
  const dto = buildPaneLookup(rawState(), "%1", new Map([["md-app", "p1"]]));

  expect(dto).toEqual({
    paneId: "%1",
    sessionName: "md-app",
    windowName: "main",
    windowId: "@1",
    windowIndex: 1,
    paneIndex: 0,
    active: true,
    currentCommand: "zsh",
    currentPath: "/tmp/app",
    paneWidth: 120,
    paneHeight: 40,
    projectId: "p1"
  });
  expect(buildPaneLookup(rawState(), "%missing", new Map())).toBe(null);
});

test("PaneService.splitPane uses the feature worktree as cwd", () => {
  const env = freshStoresEnv("md-pane-service-");
  try {
    const projectId = seedProject(env.projects, {
      workingDir: "/tmp/project",
      tmuxSessionName: "md-app"
    });
    seedFeature(env.features, projectId, {
      tmuxWindowName: "main",
      worktreePath: "/tmp/project-worktree"
    });
    const calls: string[][] = [];
    const client: TmuxClient = {
      socketArgs: [],
      runner: {
        run(_command, args) {
          calls.push(args);
          return { status: 0, signal: null, stdout: "%2\n", stderr: "" };
        }
      }
    };
    const refreshed: string[][] = [];
    const service = new PaneService({
      projects: env.projects,
      features: env.features,
      tmuxClient: client,
      getRawState: rawState,
      refreshWindows: (windowIds) => refreshed.push(windowIds)
    });

    expect(service.splitPane("%1", "right")).toEqual({ paneId: "%2" });
    expect(calls[0]).toEqual([
      "split-window", "-h", "-t", "%1", "-c", "/tmp/project-worktree", "-P", "-F", "#{pane_id}"
    ]);
    expect(refreshed).toEqual([["@1"]]);
  } finally {
    env.cleanup();
  }
});

function rawState(): RawTmuxState {
  return {
    sessions: [],
    clients: [],
    windows: [{
      sessionName: "md-app",
      windowId: "@1",
      windowIndex: 1,
      windowName: "main",
      windowActive: true,
      windowPanes: 1,
      windowLayout: "",
      windowZoomed: false
    }],
    panes: [{
      sessionName: "md-app",
      windowId: "@1",
      paneId: "%1",
      windowIndex: 1,
      windowName: "main",
      paneIndex: 0,
      paneActive: true,
      windowActive: true,
      currentPath: "/tmp/app",
      currentCommand: "zsh",
      paneTitle: "",
      panePid: 123,
      paneTty: "/dev/ttys001",
      paneWidth: 120,
      paneHeight: 40,
      captureHash: "hash",
      changedAt: "2026-05-10T00:00:00.000Z",
      preview: "",
      processes: [],
      foregroundProcesses: []
    }]
  };
}
