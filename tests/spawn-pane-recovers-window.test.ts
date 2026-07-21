import { afterEach, describe, expect, test } from "bun:test";
import { startFakeTmuxServer, type FakeTmuxServer } from "./helpers/fake-tmux.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import type { FeaturesStore } from "../src/server/modules/features/features-store.js";
import type { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { tmuxNewSession, tmuxNewWindow } from "../src/server/platform/tmux/tmux.js";

/**
 * A feature's tmux window can vanish — someone closes it, a machine reboots.
 * `spawn_pane` splits an existing window, so once the window is gone the agent
 * only ever gets "can't find window" back, while the Create pane button
 * recovers because its route reconciles first.
 *
 * That asymmetry is the bug: the one action that unblocks the feature was
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

const FEATURE = {
  id: "f1",
  projectId: "p1",
  name: "feat",
  tmuxWindowName: "feat_one",
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
  const featuresStore = {
    getById: (id: string) => (id === FEATURE.id ? FEATURE : null),
    listActiveByProject: () => [FEATURE]
  } as unknown as FeaturesStore;
  return new TmuxRuntime({ tmuxClient: fake.client, projectsStore, featuresStore });
}

const issued = (fake: FakeTmuxServer, command: string) =>
  fake.calls.filter((call) => call[0] === command);

describe("spawnPane when the feature window is gone", () => {
  test("rebuilds the window and returns a pane", async () => {
    server = startFakeTmuxServer();
    tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);

    const pane = await runtime(server).spawnPane({ featureId: FEATURE.id, cwd: "/work" });

    expect(pane.id).toBeTruthy();
    expect(pane.featureId).toBe(FEATURE.id);
    expect(
      issued(server, "new-window").some((call) => call.includes(FEATURE.tmuxWindowName))
    ).toBe(true);
  });

  test("rebuilds the session too when the whole session is gone", async () => {
    // The window cannot come back without something to hold it.
    server = startFakeTmuxServer();

    const pane = await runtime(server).spawnPane({ featureId: FEATURE.id, cwd: "/work" });

    expect(pane.id).toBeTruthy();
    expect(issued(server, "new-session")).not.toHaveLength(0);
  });

  test("splits only after the window exists", async () => {
    // Order is the whole point: a split issued first is the failure being fixed.
    server = startFakeTmuxServer();
    tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);

    await runtime(server).spawnPane({ featureId: FEATURE.id, cwd: "/work" });

    const names = server.calls.map((call) => call[0]);
    expect(names.indexOf("new-window")).toBeGreaterThan(-1);
    expect(names.indexOf("split-window")).toBeGreaterThan(names.indexOf("new-window"));
  });
});

describe("spawnPane when the window is already there", () => {
  test("does not rebuild anything", async () => {
    // Reconcile is two cheap queries in the ordinary case and must stay
    // additive: it may never replace a window that is carrying live work.
    server = startFakeTmuxServer();
    tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);
    tmuxNewWindow(PROJECT.tmuxSessionName, FEATURE.tmuxWindowName, "/work", server.client);
    const before = server.calls.length;

    const pane = await runtime(server).spawnPane({ featureId: FEATURE.id, cwd: "/work" });

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
    tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);
    tmuxNewWindow(PROJECT.tmuxSessionName, FEATURE.tmuxWindowName, "/work", server.client);

    const rt = runtime(server);
    const first = await rt.spawnPane({ featureId: FEATURE.id, cwd: "/work" });
    const second = await rt.spawnPane({ featureId: FEATURE.id, cwd: "/work" });

    expect(second.id).not.toBe(first.id);
    expect(await rt.listPanes(FEATURE.id)).toHaveLength(3);
  });
});

describe("a feature Mandate does not own", () => {
  test("is left alone rather than having its window recreated", async () => {
    // Reconcile reports an adopted window broken instead of building over
    // someone else's session; the split then fails with tmux's own message.
    server = startFakeTmuxServer();
    tmuxNewSession(PROJECT.tmuxSessionName, "/work", server.client);
    const adopted = { ...FEATURE, ownership: "adopted" };
    const rt = new TmuxRuntime({
      tmuxClient: server.client,
      projectsStore: {
        getById: () => PROJECT,
        listActive: () => [PROJECT]
      } as unknown as ProjectsStore,
      featuresStore: {
        getById: () => adopted,
        listActiveByProject: () => [adopted]
      } as unknown as FeaturesStore
    });

    await expect(rt.spawnPane({ featureId: FEATURE.id, cwd: "/work" })).rejects.toThrow();
    expect(
      issued(server, "new-window").some((call) => call.includes(FEATURE.tmuxWindowName))
    ).toBe(false);
  });
});
