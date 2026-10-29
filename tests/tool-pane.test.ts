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
import { stub, toolContext } from "./helpers/typed.js";
import type { FeatureToolContext, ToolContext } from "../src/server/modules/agent/tool-registry.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";
import type { FeatureRow, FeaturesStore } from "../src/server/modules/features/features-store.js";
import type { ProjectRow, ProjectsStore } from "../src/server/modules/projects/projects-store.js";

function ctx(opts: {
  tmuxClient: TmuxClient;
  featureWindowName?: string;
  sessionName?: string;
  analyzer?: FeatureToolContext["analyzer"];
  paneMetadata?: PaneMetadataStore;
}): ToolContext {
  // Build a real TmuxRuntime backed by stub stores so paneRuntime.listPanes
  // can issue tmux list-panes against the test server. The stub stores only
  // need to return the feature/project the helpers ask for.
  const featureWindowName = opts.featureWindowName ?? "feat1";
  const sessionName = opts.sessionName ?? "md-test";
  const feature = stub<FeatureRow>({
    id: "f",
    projectId: "p",
    worktreePath: "/tmp",
    tmuxWindowName: featureWindowName
  });
  const project = stub<ProjectRow>({
    id: "p",
    workingDir: "/tmp",
    tmuxSessionName: sessionName
  });
  const featuresStore = stub<FeaturesStore>({
    getById: (id: string) => (id === "f" ? feature : null),
    listActiveByProject: () => [feature]
  });
  const projectsStore = stub<ProjectsStore>({
    getById: (id: string) => (id === "p" ? project : null),
    listActive: () => [project]
  });
  const paneRuntime = new TmuxRuntime({
    tmuxClient: opts.tmuxClient,
    projectsStore,
    featuresStore
  });
  return toolContext({
    threadId: "t",
    wakeId: "w",
    scope: { kind: "worker", feature: { workingDir: "/tmp" }, project: { workingDir: "/tmp" } },
    feature,
    project,
    tmuxClient: opts.tmuxClient,
    analyzer: opts.analyzer ?? new Analyzer(),
    paneRuntime,
    paneMetadata: opts.paneMetadata
  });
}

test("listPanesTool: lists panes in this feature's window only", async () => {
  const tmux = startFakeTmuxServer();
  try {
    tmuxNewSession("md-test", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat1", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat2", "/tmp", tmux.client);
    const r = await listPanesTool.handler({}, ctx({ tmuxClient: tmux.client }));
    expect(Array.isArray(r.panes)).toBe(true);
    expect(r.panes.length).toBe(1);
  } finally {
    tmux.cleanup();
  }
});

test("paneStatusTool: answers what the analyser decided for the pane, with when its output last changed", async () => {
  const tmux = startFakeTmuxServer();
  try {
    tmuxNewSession("md-test", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat1", "/tmp", tmux.client);
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
    tmuxNewSession("md-test", "/tmp", tmux.client);
    tmuxNewWindow("md-test", "feat1", "/tmp", tmux.client);
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

const spawnPaneArgs: { name: string; args: Record<string, unknown>; accepted: boolean }[] = [
  { name: "command is not an accepted parameter", args: { command: "codex" }, accepted: false },
  { name: "accepts layout hints", args: { direction: "down", targetPaneId: "%3" }, accepted: true },
  { name: "refuses a split direction other than right or down", args: { direction: "left" }, accepted: false },
  { name: "accepts optional pane metadata",
    args: { direction: "down", targetPaneId: "%3", name: "Tests", description: "Runs the verification commands for this feature" }, accepted: true }
];

test.each(spawnPaneArgs)("spawn_pane: $name", ({ args, accepted }) => {
  expect(spawnPaneTool.parameters.safeParse(args).success).toBe(accepted);
});

test("send_keys: a description is offered to the model as an optional label", () => {
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
