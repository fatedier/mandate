import { expect, test } from "bun:test";
import { startFakeTmuxServer } from "./helpers/fake-tmux.js";
import { tmuxNewSession, tmuxNewWindow } from "../src/server/platform/tmux/tmux.js";
import { killPaneTool } from "../src/server/modules/panes/tools/kill-pane.js";
import { listPanesTool } from "../src/server/modules/panes/tools/list-panes.js";
import { paneStatusTool } from "../src/server/modules/panes/tools/pane-status.js";
import { buildReadPaneTool } from "../src/server/modules/panes/tools/read-pane.js";
import { sendKeysTool } from "../src/server/modules/panes/tools/send-keys.js";
import { spawnPaneTool } from "../src/server/modules/panes/tools/spawn-pane.js";
import { setPaneMetadataTool } from "../src/server/modules/panes/tools/set-pane-metadata.js";
import { PaneMetadataStore } from "../src/server/modules/panes/pane-metadata-store.js";
import { PaneReadCursorStore } from "../src/server/modules/panes/pane-read-cursor.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

function ctx(opts: {
  tmuxClient: any;
  featureWindowName?: string;
  sessionName?: string;
  analyzer?: any;
  paneMetadata?: PaneMetadataStore;
}) {
  // Build a real TmuxRuntime backed by stub stores so paneRuntime.listPanes
  // can issue tmux list-panes against the test server. The stub stores only
  // need to return the feature/project the helpers ask for.
  const featureWindowName = opts.featureWindowName ?? "feat1";
  const sessionName = opts.sessionName ?? "md-test";
  const feature = {
    id: "f",
    projectId: "p",
    workingDir: "/tmp",
    tmuxWindowName: featureWindowName
  } as any;
  const project = {
    id: "p",
    workingDir: "/tmp",
    tmuxSessionName: sessionName
  } as any;
  const featuresStore = {
    getById: (id: string) => (id === "f" ? feature : null),
    listActiveByProject: () => [feature]
  } as any;
  const projectsStore = {
    getById: (id: string) => (id === "p" ? project : null),
    listActive: () => [project]
  } as any;
  const paneRuntime = new TmuxRuntime({
    tmuxClient: opts.tmuxClient,
    projectsStore,
    featuresStore
  });
  return {
    threadId: "t",
    wakeId: "w",
    feature,
    project,
    tmuxClient: opts.tmuxClient,
    analyzer: opts.analyzer ?? { getCachedAnalysis: () => null },
    paneRuntime,
    paneMetadata: opts.paneMetadata
  } as any;
}

test("listPanesTool: lists panes in this feature's window only", async () => {
  const tmux = startFakeTmuxServer();
  try {
    tmuxNewSession("md-test", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat1", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat2", "/tmp", tmux.client);
    const r = await listPanesTool.handler({}, ctx({ tmuxClient: tmux.client }));
    expect(Array.isArray((r as any).panes)).toBe(true);
    expect((r as any).panes.length).toBe(1);
  } finally {
    tmux.cleanup();
  }
});

test("read_pane: rejects paneId outside this feature window", async () => {
  const tmux = startFakeTmuxServer();
  try {
    tmuxNewSession("md-test", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat1", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat2", "/tmp", tmux.client);
    const r = await buildReadPaneTool({ cursors: new PaneReadCursorStore() }).handler(
      { paneId: "%999" },
      ctx({ tmuxClient: tmux.client })
    );
    expect((r as any).error).toMatch(/not in.*feature window|scope/i);
  } finally {
    tmux.cleanup();
  }
});

test("paneStatusTool: returns analyzer-cached status when injected", async () => {
  const tmux = startFakeTmuxServer();
  try {
    tmuxNewSession("md-test", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat1", "/tmp", tmux.client);
    const list = (await listPanesTool.handler({}, ctx({ tmuxClient: tmux.client }))) as any;
    const paneId = list.panes[0].paneId;
    const fakeAnalyzer = {
      getCachedAnalysis: (id: string) =>
        id === paneId
          ? {
              status: "working",
              summary: "doing things",
              taskTitle: "X",
              confidence: 0.9,
              changedAt: "now"
            }
          : null
    };
    const r = await paneStatusTool.handler(
      { paneId },
      ctx({ tmuxClient: tmux.client, analyzer: fakeAnalyzer })
    );
    expect((r as any).status).toBe("working");
    expect((r as any).summary).toBe("doing things");
  } finally {
    tmux.cleanup();
  }
});

test("pane metadata tools: update labels and surface them in pane listings", async () => {
  const env = freshAgentEnv("md-pane-meta-");
  const tmux = startFakeTmuxServer();
  try {
    tmuxNewSession("md-test", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat1", "/tmp", tmux.client);
    const paneMetadata = new PaneMetadataStore(env.store.db);
    const toolCtx = ctx({ tmuxClient: tmux.client, paneMetadata });
    const list = (await listPanesTool.handler({}, toolCtx)) as any;
    const paneId = list.panes[0].paneId;

    const updated = await setPaneMetadataTool.handler(
      { paneId, name: "Codex", description: "Interactive planning pane" },
      toolCtx
    );
    expect((updated as any).error).toBeUndefined();
    expect(updated).toMatchObject({
      ok: true,
      paneId
    });

    const nextList = (await listPanesTool.handler({}, toolCtx)) as any;
    expect(nextList.panes[0]).toMatchObject({
      paneId,
      name: "Codex",
      description: "Interactive planning pane"
    });
    const status = await paneStatusTool.handler({ paneId }, toolCtx);
    expect(status).toMatchObject({
      status: "unknown",
      name: "Codex",
      description: "Interactive planning pane"
    });
  } finally {
    tmux.cleanup();
    env.cleanup();
  }
});

test("pane tool descriptions: existing terminals use send_keys, not spawn_pane", () => {
  expect(sendKeysTool.description).toMatch(/existing user-visible terminal pane/);
  expect(sendKeysTool.description).toMatch(/tmux send-keys/);
  expect(sendKeysTool.description).toMatch(/args/);
  expect(sendKeysTool.description).toMatch(/do not include `-t`/);
  expect(sendKeysTool.description).toMatch(
    /complete\s+instruction to codex, claude, aider, or another interactive terminal agent/
  );
  expect(sendKeysTool.description).toMatch(/second call args=\["Enter"\]/);
  expect(spawnPaneTool.description).toMatch(/Create a new shell terminal pane/);
  expect(spawnPaneTool.description).toMatch(/does not accept a command/);
  expect(spawnPaneTool.description).toMatch(/then call send_keys/);
  expect(spawnPaneTool.description).toMatch(/instead of raw tmux split-window\/new-window/);
  expect(spawnPaneTool.description).toMatch(/returns the correct\s+paneId/);
  expect(killPaneTool.description).toMatch(/instead of raw tmux kill-pane/);
  expect(killPaneTool.description).toMatch(/scope checks stay intact/);
});

test("spawn_pane: command is not an accepted parameter", () => {
  const parsed = spawnPaneTool.parameters.safeParse({ command: "codex" });
  expect(parsed.success).toBe(false);
});

test("spawn_pane: accepts layout hints", () => {
  const parsed = spawnPaneTool.parameters.safeParse({
    direction: "down",
    targetPaneId: "%3"
  });
  expect(parsed.success).toBe(true);
  expect(spawnPaneTool.parameters.safeParse({ direction: "left" }).success).toBe(false);
});

test("spawn_pane: accepts optional pane metadata", () => {
  const parsed = spawnPaneTool.parameters.safeParse({
    direction: "down",
    targetPaneId: "%3",
    name: "Tests",
    description: "Runs the verification commands for this feature"
  });
  expect(parsed.success).toBe(true);
});
