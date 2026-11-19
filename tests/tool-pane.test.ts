import { expect, test } from "bun:test";
import { startFakeTmuxServer } from "./helpers/fake-tmux.js";
import { tmuxNewSession, tmuxNewWindow } from "../src/server/platform/tmux/tmux.js";
import { killPaneTool } from "../src/server/modules/panes/tools/kill-pane.js";
import { listPanesTool } from "../src/server/modules/panes/tools/list-panes.js";
import { paneStatusTool } from "../src/server/modules/panes/tools/pane-status.js";
import { sendKeysTool } from "../src/server/modules/panes/tools/send-keys.js";
import { z } from "zod";
import { spawnPaneTool } from "../src/server/modules/panes/tools/spawn-pane.js";
import { setPaneMetadataTool } from "../src/server/modules/panes/tools/set-pane-metadata.js";
import { PaneMetadataStore } from "../src/server/modules/panes/pane-metadata-store.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import { analyseWindow } from "./helpers/analysis.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { stub, workerToolContext } from "./helpers/typed.js";
import type { WorkerToolContext, ToolContext } from "../src/server/modules/agent/tool-registry.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";
import type { WorkerRow, WorkersStore } from "../src/server/modules/workers/workers-store.js";
import type { ProjectRow, ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import type { Pane } from "../src/server/runtime/pane-runtime.js";

function ctx(opts: {
  tmuxClient: TmuxClient;
  workerWindowName?: string;
  sessionName?: string;
  analyzer?: WorkerToolContext["analyzer"];
  paneMetadata?: PaneMetadataStore;
}): ToolContext {
  // Build a real TmuxRuntime backed by stub stores so paneRuntime.listPanes
  // can issue tmux list-panes against the test server. The stub stores only
  // need to return the feature/project the helpers ask for.
  const workerWindowName = opts.workerWindowName ?? "wkr1";
  const sessionName = opts.sessionName ?? "md-test";
  const worker = stub<WorkerRow>({
    id: "f",
    projectId: "p",
    worktreePath: "/tmp",
    tmuxWindowName: workerWindowName
  });
  const project = stub<ProjectRow>({
    id: "p",
    workingDir: "/tmp",
    tmuxSessionName: sessionName
  });
  const workersStore = stub<WorkersStore>({
    getById: (id: string) => (id === "f" ? worker : null),
    listActiveByProject: () => [worker]
  });
  const projectsStore = stub<ProjectsStore>({
    getById: (id: string) => (id === "p" ? project : null),
    listActive: () => [project]
  });
  const paneRuntime = new TmuxRuntime({
    tmuxClient: opts.tmuxClient,
    projectsStore,
    workersStore
  });
  return workerToolContext("/tmp", {
    threadId: "t",
    wakeId: "w",
    worker,
    project,
    tmuxClient: opts.tmuxClient,
    analyzer: opts.analyzer ?? new Analyzer(),
    paneRuntime,
    paneMetadata: opts.paneMetadata
  });
}

test("listPanesTool: lists panes in this worker's window only", async () => {
  const tmux = startFakeTmuxServer();
  try {
    await tmuxNewSession("md-test", "/tmp", tmux.client);
    await tmuxNewWindow("md-test", "wkr1", "/tmp", tmux.client);
    await tmuxNewWindow("md-test", "wkr2", "/tmp", tmux.client);
    const r = await listPanesTool.handler({}, ctx({ tmuxClient: tmux.client }));
    const ownPane = tmux.answer(["list-panes", "-t", "md-test:wkr1", "-F", "#{pane_id}"]).stdout.trim();
    expect(r.panes.map((pane: { paneId: string }) => pane.paneId)).toStrictEqual([ownPane]);
  } finally {
    tmux.cleanup();
  }
});

test("paneStatusTool: answers what the analyser decided for the pane, with when its output last changed", async () => {
  const tmux = startFakeTmuxServer();
  try {
    await tmuxNewSession("md-test", "/tmp", tmux.client);
    await tmuxNewWindow("md-test", "wkr1", "/tmp", tmux.client);
    const list = await listPanesTool.handler({}, ctx({ tmuxClient: tmux.client }));
    const paneId = list.panes[0].paneId;
    const analyzer = new Analyzer();
    analyseWindow(analyzer, [{
      paneId, currentCommand: "zsh", capture: "alice@host p % ", foreground: ["-zsh"], changedAt: "2026-05-01T09:30:00.000Z"
    }]);
    const r = await paneStatusTool.handler({ paneId }, ctx({ tmuxClient: tmux.client, analyzer }));
    expect(r).toMatchObject({ status: "idle_shell", summary: "zsh in /tmp", changedAt: "2026-05-01T09:30:00.000Z" });
  } finally {
    tmux.cleanup();
  }
});

test("pane metadata tools: update labels and surface them in pane listings", async () => {
  const env = freshAgentEnv("md-pane-meta-");
  const tmux = startFakeTmuxServer();
  try {
    await tmuxNewSession("md-test", "/tmp", tmux.client);
    await tmuxNewWindow("md-test", "wkr1", "/tmp", tmux.client);
    const paneMetadata = new PaneMetadataStore(env.store.db);
    const toolCtx = ctx({ tmuxClient: tmux.client, paneMetadata });
    const list = await listPanesTool.handler({}, toolCtx);
    const paneId = list.panes[0].paneId;

    const updated = await setPaneMetadataTool.handler(
      { paneId, name: "Codex", description: "Interactive planning pane" },
      toolCtx
    );
    expect(updated.error).toBeUndefined();
    expect(updated).toMatchObject({
      ok: true,
      paneId
    });

    const nextList = await listPanesTool.handler({}, toolCtx);
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

test("pane tool descriptions: existing terminals use send_keys, not spawn_pane", async () => {
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

const spawnPaneArgs: { name: string; args: Record<string, unknown>; accepted: boolean }[] = [
  { name: "command is not an accepted parameter", args: { command: "codex" }, accepted: false },
  { name: "accepts layout hints", args: { direction: "down", targetPaneId: "%3" }, accepted: true },
  { name: "refuses a split direction other than right or down", args: { direction: "left" }, accepted: false },
  { name: "accepts optional pane metadata",
    args: { direction: "down", targetPaneId: "%3", name: "Tests", description: "Runs the verification commands for this worker" }, accepted: true }
];

test.each(spawnPaneArgs)("spawn_pane: $name", ({ args, accepted }) => {
  expect(spawnPaneTool.parameters.safeParse(args).success).toBe(accepted);
});

test("send_keys: a description is offered to the model as an optional label", async () => {
  const schema = z.toJSONSchema(sendKeysTool.parameters) as { properties: Record<string, { description?: string }>; required?: string[] };
  const asked = schema.properties.description?.description ?? "";
  expect(asked).toMatch(/^What these keys do/);
  expect(asked).toMatch(/do not repeat them or the text typed/);
  expect(asked).toMatch(/5-10 words/);
  expect(asked).toContain('["C-c"] -> "Stop the dev server"');
  expect(schema.required ?? []).not.toContain("description");
  expect(sendKeysTool.parameters.parse({ paneId: "%1", args: ["C-c"], description: "Stop the dev server" }))
    .toMatchObject({ args: ["C-c"], description: "Stop the dev server" });
});

// A worker that opens a pane for every task, closing none, fills its window.
// Past six panes — more than most workers ever use — a new one is refused,
// and the refusal lists the panes so one can be reused or closed.

function harness(count: number, opts: { names?: Record<string, string>; status?: Record<string, string> } = {}) {
  const spawned: string[] = [];
  const panes = Array.from({ length: count }, (_, i) => stub<Pane>({
    id: `%${i + 1}`, command: ["zsh"], cwd: "/tmp", spawnedAt: "2026-10-27T08:00:00.000Z"}));
  const ctx = workerToolContext("/tmp", {
    threadId: "t1",
    wakeId: "w1",
    worker: stub<WorkerRow>({ id: "f", projectId: "p", worktreePath: "/tmp", tmuxWindowName: "w" }),
    project: stub<ProjectRow>({ id: "p", workingDir: "/tmp", tmuxSessionName: "s" }),
    paneRuntime: stub<TmuxRuntime>({
      listPanes: async () => panes,
      spawnPane: async () => { spawned.push("new"); return stub<Pane>({ id: "%99" }); }
    }),
    paneMetadata: stub<PaneMetadataStore>({
      get: (id: string) => (opts.names?.[id] ? stub<ReturnType<PaneMetadataStore["get"]> & object>({ name: opts.names[id] }) : null),
      upsert: () => stub<ReturnType<PaneMetadataStore["upsert"]>>({})
    }),
    analyzer: stub<Analyzer>({
      getCachedAnalysis: (id: string) => (opts.status?.[id] ? stub<NonNullable<ReturnType<Analyzer["getCachedAnalysis"]>>>({ status: opts.status[id] as never }) : null)
    })
  });
  return { ctx, spawned };
}

test("with six panes a new one is refused, and the refusal names each pane and what it is doing", async () => {
  const { ctx, spawned } = harness(6, {
    names: { "%1": "Review", "%2": "Dev server" },
    status: { "%1": "done", "%2": "running_service", "%3": "idle_shell" }
  });
  const result = await spawnPaneTool.handler({ name: "Another review" }, ctx);
  expect(spawned).toEqual([]);
  expect(result.paneId).toBeUndefined();
  expect(result.error).toContain("already has 6 panes");
  expect(result.error).toContain("kill_pane");
  for (const line of ["%1 Review: done", "%2 Dev server: running_service", "%3 zsh: idle_shell", "%4 zsh: running", "%6 zsh: running"]) {
    expect(result.error).toContain(line);
  }
});

test("under six panes one is made", async () => {
  const { ctx, spawned } = harness(5);
  const result = await spawnPaneTool.handler({}, ctx);
  expect(spawned).toEqual(["new"]);
  expect(result).toEqual({ paneId: "%99" });
});
