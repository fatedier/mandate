import { expect, test } from "bun:test";
import { buildPaneLookup, PaneService } from "../src/server/modules/panes/pane-service.js";
import { buildSessionsDto } from "../src/server/modules/sessions/session-service.js";
import { MandateStore } from "../src/server/app/store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { tmuxNewSession, type TmuxClient } from "../src/server/platform/tmux/tmux.js";
import type { RawTmuxState } from "../src/server/platform/tmux/tmux-types.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { startFakeTmuxServer } from "./helpers/fake-tmux.js";
import { tempDir } from "./helpers/temp.js";
import { buildSessionsTestApp, getJson } from "./helpers/test-app.js";

test("buildSessionsDto enriches tmux sessions with ownership and raw panes", async () => {
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
        currentPath: "/tmp/app",
        title: null,
        pid: 123
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

test("buildPaneLookup maps raw pane geometry and owning project id", async () => {
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
    pid: 123,
    paneWidth: 120,
    paneHeight: 40,
    projectId: "p1",
    foregroundProcesses: []
  });
  expect(buildPaneLookup(rawState(), "%missing", new Map())).toBe(null);
});

test("buildPaneLookup carries the foreground commands, so a wrapper can be seen through", async () => {
  const raw = rawState();
  raw.panes[0]!.currentCommand = "node";
  raw.panes[0]!.foregroundProcesses = [{ pid: 9, ppid: 123, state: "S+", command: "node /opt/homebrew/bin/codex" }];
  expect(buildPaneLookup(raw, "%1", new Map())?.foregroundProcesses).toEqual([{ command: "node /opt/homebrew/bin/codex" }]);
});

test("PaneService.splitPane uses the worker worktree as cwd", async () => {
  const env = freshStoresEnv("md-pane-service-");
  const projectId = seedProject(env.projects, {
    workingDir: "/tmp/project",
    tmuxSessionName: "md-app"
  });
  seedWorker(env.workers, projectId, {
    tmuxWindowName: "main",
    worktreePath: "/tmp/project-worktree"
  });
  const calls: string[][] = [];
  const client: TmuxClient = {
    socketArgs: [],
    runner: {
      async run(_command, args) {
        calls.push(args);
        return { status: 0, signal: null, stdout: "%2\n", stderr: "" };
      }
    }
  };
  const refreshed: string[][] = [];
  const service = new PaneService({
    projects: env.projects,
    workers: env.workers,
    tmuxClient: client,
    getRawState: rawState,
    refreshWindows: (windowIds) => refreshed.push(windowIds)
  });

  expect(await service.splitPane("%1", "right")).toEqual({ paneId: "%2" });
  expect(calls[0]).toEqual([
    "split-window", "-h", "-t", "%1", "-c", "/tmp/project-worktree", "-P", "-F", "#{pane_id}"
  ]);
  expect(refreshed).toStrictEqual([["@1"]]);
});

function rawState(): RawTmuxState {
  return {
    sessions: [],
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

function serviceWith(raw: ReturnType<typeof rawState>, psOutput: string, calls: Array<{ command: string; args: string[] }>) {
  const env = freshStoresEnv("md-pane-lookup-");
  const client: TmuxClient = {
    socketArgs: [],
    runner: {
      async run(command, args) {
        calls.push({ command, args });
        return { status: 0, signal: null, stdout: psOutput, stderr: "" };
      }
    }
  };
  const service = new PaneService({
    projects: env.projects, workers: env.workers, tmuxClient: client, getRawState: () => raw, refreshWindows: () => {}
  });
  return { service, cleanup: env.cleanup };
}

test("a pane in a window Mandate does not monitor has its foreground read when looked up", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const { service } = serviceWith(rawState(), "123 1 Ss -zsh\n9 123 S+ node /opt/homebrew/bin/codex\n", calls);
  expect((await service.getPane("%1"))?.foregroundProcesses).toEqual([{ command: "node /opt/homebrew/bin/codex" }]);
  expect(calls).toStrictEqual([{ command: "ps", args: ["-t", "ttys001", "-o", "pid=,ppid=,state=,command="] }]);
});

test("a monitored pane's lookup reads its processes now: the last poll can be seconds behind a program just started", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const raw = rawState();
  raw.panes[0]!.processes = [{ pid: 123, ppid: 1, state: "Ss+", command: "-zsh" }];
  raw.panes[0]!.foregroundProcesses = [{ pid: 123, ppid: 1, state: "Ss+", command: "-zsh" }];
  const { service } = serviceWith(raw, "123 1 Ss -zsh\n9 123 S+ codex\n", calls);
  expect((await service.getPane("%1"))?.foregroundProcesses).toEqual([{ command: "codex" }]);
  expect(calls.length).toBe(1);
});

test("a lookup whose ps fails falls back to what the last poll read", async () => {
  const raw = rawState();
  raw.panes[0]!.processes = [{ pid: 9, ppid: 123, state: "S+", command: "codex" }];
  raw.panes[0]!.foregroundProcesses = [{ pid: 9, ppid: 123, state: "S+", command: "codex" }];
  const env = freshStoresEnv("md-pane-lookup-");
  const client: TmuxClient = {
    socketArgs: [],
    runner: { run: async () => ({ status: 1, signal: null, stdout: "", stderr: "ps: failed" }) }
  };
  const service = new PaneService({
    projects: env.projects, workers: env.workers, tmuxClient: client, getRawState: () => raw, refreshWindows: () => {}
  });
  expect((await service.getPane("%1"))?.foregroundProcesses).toEqual([{ command: "codex" }]);
});

test("GET /api/tmux/sessions classifies sessions as managed vs unmanaged", async () => {
  const dbDir = tempDir("md-db-");
  const tmux = startFakeTmuxServer();
  let store: MandateStore | undefined;
  try {
    store = new MandateStore(dbDir);
    const projects = new ProjectsStore(store.db);

    // Seed: one project (managed) + one external session (unmanaged)
    const projectId = seedProject(projects, { name: "MyApp", tmuxSessionName: "md-myapp" });
    await tmuxNewSession("md-myapp", "/tmp", tmux.client);
    await tmuxNewSession("external-thing", "/tmp", tmux.client);

    const app = buildSessionsTestApp({
      projects,
      tmuxClient: tmux.client,
      getRawState: () => null
    });
    const r = await getJson(app, "/api/tmux/sessions");
    expect(r.status).toBe(200);
    const byName = new Map<string, any>(r.body.sessions.map((s: any) => [s.name, s]));

    const managed = byName.get("md-myapp");
    expect(managed).toBeTruthy();
    expect(managed.ownership).toBe("managed");
    expect(managed.projectId).toBe(projectId);
    expect(managed.projectName).toBe("MyApp");
    expect(Array.isArray(managed.windows)).toBeTruthy();

    const unmanaged = byName.get("external-thing");
    expect(unmanaged).toBeTruthy();
    expect(unmanaged.ownership).toBe("unmanaged");
    expect(unmanaged.projectId).toBe(null);
    expect(Array.isArray(unmanaged.windows)).toBeTruthy();
  } finally {
    store?.db.close();
    tmux.cleanup();
  }
});
