import { afterEach, describe, expect, test } from "bun:test";
import { startFakeTmuxServer, type FakeTmuxServer } from "./helpers/fake-tmux.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import type { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import type { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { tmuxNewSession, tmuxNewWindow } from "../src/server/platform/tmux/tmux.js";

/**
 * A worker's tmux window can vanish — someone closes it, a machine reboots.
 * `spawn_pane` splits an existing window, so once the window is gone the agent
 * only ever gets "can't find window" back, while the Create pane button
 * recovers because its route reconciles first.
 *
 * That asymmetry is the bug: the one action that unblocks the worker was
 * reachable from the UI and from nowhere else, so an agent that hit it had
 * nothing left to do but wait for a person to notice. Recovery belongs to the
 * operation, not to one of its two callers.
 */

const PROJECT = {
  id: "p1",
  name: "P",
  workingDir: "/work",
  tmuxSessionName: "md-p",
  ownership: "app",
  isGit: false,
  gitRemote: null,
  archivedAt: null
};

const WORKER = {
  id: "f1",
  projectId: "p1",
  name: "wkr",
  tmuxWindowName: "wkr_one",
  worktreePath: null,
  ownership: "app",
  archivedAt: null
};

let server: FakeTmuxServer | null = null;

afterEach(() => {
  server?.cleanup();
  server = null;
});

function runtime(fake: FakeTmuxServer) {
  const projectsStore = {
    getById: (id: string) => (id === PROJECT.id ? PROJECT : null),
    listActive: () => [PROJECT]
  } as unknown as ProjectsStore;
  const workersStore = {
    getById: (id: string) => (id === WORKER.id ? WORKER : null),
    listActiveByProject: () => [WORKER]
  } as unknown as WorkersStore;
  return new TmuxRuntime({ tmuxClient: fake.client, projectsStore, workersStore });
}

const issued = (fake: FakeTmuxServer, command: string) =>
  fake.calls.filter((call) => call[0] === command);

describe("spawnPane when the worker window is gone", () => {
  test("rebuilds the window and returns a pane", async () => {
    server = startFakeTmuxServer();
    await tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);

    const pane = await runtime(server).spawnPane({ workerId: WORKER.id, cwd: "/work" });

    expect(pane.id).toBeTruthy();
    expect(pane.workerId).toBe(WORKER.id);
    expect(
      issued(server, "new-window").some((call) => call.includes(WORKER.tmuxWindowName))
    ).toBe(true);
  });

  test("rebuilds the session too when the whole session is gone", async () => {
    // The window cannot come back without something to hold it.
    server = startFakeTmuxServer();

    const pane = await runtime(server).spawnPane({ workerId: WORKER.id, cwd: "/work" });

    expect(pane.id).toBeTruthy();
    expect(issued(server, "new-session")).not.toHaveLength(0);
  });

});

describe("spawnPane when the window is already there", () => {
  test("does not rebuild anything", async () => {
    // Reconcile is two cheap queries in the ordinary case and must stay
    // additive: it may never replace a window that is carrying live work.
    server = startFakeTmuxServer();
    await tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);
    await tmuxNewWindow(PROJECT.tmuxSessionName, WORKER.tmuxWindowName, "/work", server.client);
    const before = server.calls.length;

    const pane = await runtime(server).spawnPane({ workerId: WORKER.id, cwd: "/work" });

    expect(pane.id).toBeTruthy();
    expect(
      server.calls.slice(before).filter((call) => call[0] === "new-window")
    ).toHaveLength(0);
    expect(
      server.calls.slice(before).filter((call) => call[0] === "new-session")
    ).toHaveLength(0);
  });

  test("still adds a pane rather than reusing the window's first one", async () => {
    server = startFakeTmuxServer();
    await tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);
    await tmuxNewWindow(PROJECT.tmuxSessionName, WORKER.tmuxWindowName, "/work", server.client);

    const rt = runtime(server);
    const first = await rt.spawnPane({ workerId: WORKER.id, cwd: "/work" });
    const second = await rt.spawnPane({ workerId: WORKER.id, cwd: "/work" });

    expect(second.id).not.toBe(first.id);
    expect(await rt.listPanes(WORKER.id)).toHaveLength(3);
  });
});

describe("a worker Mandate does not own", () => {
  test("is left alone rather than having its window recreated", async () => {
    // Reconcile reports an adopted window broken instead of building over
    // someone else's session; the split then fails with tmux's own message.
    server = startFakeTmuxServer();
    await tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);
    const adopted = { ...WORKER, ownership: "adopted" };
    const rt = new TmuxRuntime({
      tmuxClient: server.client,
      projectsStore: {
        getById: () => PROJECT,
        listActive: () => [PROJECT]
      } as unknown as ProjectsStore,
      workersStore: {
        getById: () => adopted,
        listActiveByProject: () => [adopted]
      } as unknown as WorkersStore
    });

    await expect(rt.spawnPane({ workerId: WORKER.id, cwd: "/work" })).rejects.toThrow("can't find pane: md-p:wkr_one");
    expect(
      issued(server, "new-window").some((call) => call.includes(WORKER.tmuxWindowName))
    ).toBe(false);
  });
});
