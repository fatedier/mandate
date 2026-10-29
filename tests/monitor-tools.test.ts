import { expect, test } from "bun:test";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { WindowWatchManager } from "../src/server/modules/agent/window-watch-manager.js";
import { CommandMonitorManager, type MonitorRunResult } from "../src/server/modules/agent/command-monitor-manager.js";
import { buildMonitorTools } from "../src/server/modules/agent/tools/monitor.js";
import type { ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { stub, toolContext } from "./helpers/typed.js";

const START = Date.parse("2026-10-04T00:00:00.000Z");
type WatchDeps = ConstructorParameters<typeof WindowWatchManager>[0];

function managers(
  env: ReturnType<typeof freshStoresEnv>,
  script: (call: number) => Partial<MonitorRunResult> = () => ({ stdout: "101" }),
  getPaneState: WatchDeps["getPaneState"] = () => ({ status: "ok", changedAt: null })
) {
  const runs: Array<{ command: string; cwd: string }> = [];
  let now = START;
  const watchManager = new WindowWatchManager({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: () => "wake-1",
    isThreadBusy: () => false,
    getPaneState,
    capturePaneTail: async () => ""
  });
  const commandMonitorManager = new CommandMonitorManager({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: () => "wake-1",
    isThreadBusy: () => false,
    runner: { run: async (command, opts) => { runs.push({ command, cwd: opts.cwd }); return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...script(runs.length) }; } },
    clock: { now: () => now, sleep: async (ms) => { now += ms; }, setInterval: () => 0, clearInterval: () => {} }
  });
  return { watchManager, commandMonitorManager, runs, dispose: () => { watchManager.dispose(); commandMonitorManager.dispose(); } };
}
// Reached through the untyped list the builder returns; results are read as records.
const tool = (tools: ToolDefinition[], name: string) => tools.find((t) => t.name === name)! as ToolDefinition<any, any>;
const managerScope = (dir: string) => ({ kind: "manager" as const, managerDir: dir, projectWorkingDirs: [] });

test("monitor takes exactly one source", async () => {
  const env = freshStoresEnv("md-mtools-one-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const m = managers(env);
  const monitor = tool(buildMonitorTools({ scope: "manager", ...m }), "monitor");
  const ctx = toolContext({ threadId: thread.id });
  const error = { error: "monitor takes exactly one of pane or command" };
  expect(await monitor.handler({ note: "x" }, ctx)).toEqual(error);
  expect(await monitor.handler({ note: "x", pane: { paneId: "%1", featureId: "f" }, command: { run: "echo", every: "5m" } }, ctx)).toEqual(error);
  expect(m.runs).toStrictEqual([]);
  m.dispose();
});

test("a pane monitor registers through the window watch: 30s unchanged, and its timeout as a duration", async () => {
  const env = freshStoresEnv("md-mtools-pane-");
  const projectId = seedProject(env.projects, { tmuxSessionName: "md-p" });
  const featureId = seedFeature(env.features, projectId, { tmuxWindowName: "f" });
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const m = managers(env);
  const monitor = tool(buildMonitorTools({ scope: "manager", ...m, projectsStore: env.projects, featuresStore: env.features }), "monitor");
  const result = await monitor.handler({ pane: { paneId: "%1", featureId }, timeout: "1h", note: "build" }, toolContext({ threadId: thread.id }));
  expect(result).toMatchObject({ status: "registered", kind: "pane", unchangedFor: "30s" });
  expect(result.monitorId).toMatch(/^ww_/);
  expect(m.watchManager.list(thread.id)[0]).toMatchObject({ windowKey: "md-p:f", paneId: "%1", stableMs: 30_000, timeoutMs: 3_600_000, note: "build" });
  m.dispose();
});

test("a pane monitor from the manager resolves project and feature slugs", async () => {
  const env = freshStoresEnv("md-watch-tool-slug-");
  const projectId = seedProject(env.projects, { tmuxSessionName: "md-p" });
  seedFeature(env.features, projectId, { tmuxWindowName: "feat-a" });
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const seen: Array<{ windowKey: string; paneId: string | undefined }> = [];
  const m = managers(env, undefined, (windowKey, paneId) => {
    seen.push({ windowKey, paneId });
    return { status: "ok", changedAt: null };
  });

  const monitor = tool(buildMonitorTools({
    watchManager: m.watchManager,
    scope: "manager",
    projectsStore: env.projects,
    featuresStore: env.features
  }), "monitor");
  await monitor.handler(
    { pane: { projectSlug: "md-p", featureSlug: "feat-a", paneId: "%1" }, note: "build" },
    toolContext({ threadId: thread.id, wakeId: "wake-owner" })
  );
  await (m.watchManager as any).checkAll();

  expect(seen[0]).toMatchObject({ windowKey: "md-p:feat-a", paneId: "%1" });
  m.dispose();
});

test("a worker's pane monitor watches its own feature's window", async () => {
  const env = freshStoresEnv("md-watch-tool-feature-");
  const projectId = seedProject(env.projects, { tmuxSessionName: "md-p" });
  const featureId = seedFeature(env.features, projectId, { tmuxWindowName: "feat-a" });
  const project = env.projects.getById(projectId)!;
  const feature = env.features.getById(featureId)!;
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  const seen: Array<{ windowKey: string; paneId: string | undefined }> = [];
  const m = managers(env, undefined, (windowKey, paneId) => {
    seen.push({ windowKey, paneId });
    return { status: "ok", changedAt: null };
  });

  const monitor = tool(buildMonitorTools({ watchManager: m.watchManager, scope: "worker" }), "monitor");
  const result = await monitor.handler(
    { pane: { paneId: "%1" }, note: "build" },
    toolContext({
      threadId: thread.id, wakeId: "wake-owner", project, feature,
      scope: { kind: "worker", feature: { workingDir: feature.worktreePath }, project: { workingDir: project.workingDir } }
    })
  );
  await (m.watchManager as any).checkAll();

  expect(result.status).toBe("registered");
  expect(seen[0]).toMatchObject({ windowKey: "md-p:feat-a", paneId: "%1" });
  m.dispose();
});

test("a pane timeout over 2h is refused before anything registers", async () => {
  const env = freshStoresEnv("md-mtools-panetimeout-");
  const projectId = seedProject(env.projects, { tmuxSessionName: "md-p" });
  const featureId = seedFeature(env.features, projectId, { tmuxWindowName: "f" });
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const m = managers(env);
  const monitor = tool(buildMonitorTools({ scope: "manager", ...m, projectsStore: env.projects, featuresStore: env.features }), "monitor");
  expect(await monitor.handler({ pane: { paneId: "%1", featureId }, timeout: "3h", note: "build" }, toolContext({ threadId: thread.id })))
    .toEqual({ error: "a pane monitor's timeout is at most 2h" });
  expect(m.watchManager.list(thread.id)).toEqual([]);
  m.dispose();
});

test("a command monitor runs where bash runs by default and returns its first output", async () => {
  const env = freshStoresEnv("md-mtools-command-");
  const managerThread = env.agentStore.getOrCreateThread("manager", null);
  const workerThread = env.agentStore.getOrCreateThread("worker", "feat-a");
  const worktree = path.join(env.dir, "worktree");
  fs.mkdirSync(worktree);
  const m = managers(env);
  const monitor = tool(buildMonitorTools({ scope: "manager", ...m }), "monitor");
  const result = await monitor.handler(
    { command: { run: "gh pr view 1 --json comments --jq '.comments[].id'", every: "5m" }, note: "reviews" },
    toolContext({ threadId: managerThread.id, scope: managerScope(env.dir) })
  );
  expect(result).toMatchObject({ status: "registered", kind: "command", every: "5m", wakeWhen: "changed", output: "101" });
  expect(result.monitorId).toMatch(/^mon_/);
  // The two registration runs, in the manager's directory.
  expect(m.runs.map((r) => r.cwd)).toStrictEqual([env.dir, env.dir]);
  const workerMonitor = tool(buildMonitorTools({ scope: "worker", ...m }), "monitor");
  await workerMonitor.handler(
    { command: { run: "gh pr checks 1", every: "5m", wakeWhen: "succeeds" }, note: "ci" },
    toolContext({ threadId: workerThread.id, scope: { kind: "worker", feature: { workingDir: worktree }, project: { workingDir: env.dir } } })
  );
  expect(m.runs.at(-1)).toEqual({ command: "gh pr checks 1", cwd: worktree });
  m.dispose();
});

test("a command monitor's first run that wrote to stderr is returned with it, and under succeeds a failed one with a warning", async () => {
  const env = freshStoresEnv("md-mtools-stderr-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const m = managers(env, () => ({ exitCode: 1, stderr: "Unknown flag: --jq" }));
  const monitor = tool(buildMonitorTools({ scope: "manager", ...m }), "monitor");
  const result = await monitor.handler(
    { command: { run: "glab api projects/7/jobs/8 --jq .status | grep -q success", every: "1m", wakeWhen: "succeeds" }, note: "image built" },
    toolContext({ threadId: thread.id, scope: managerScope(env.dir) })
  );
  expect(result).toMatchObject({ status: "registered", exitCode: 1, output: "", stderr: "Unknown flag: --jq" });
  expect(result.warning).toContain("may be an error");
  m.dispose();
});

test("a refused command monitor is a tool result with the error and the output, not a throw", async () => {
  const env = freshStoresEnv("md-mtools-refused-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const m = managers(env, (call) => ({ stdout: `at 12:00:0${call}` }));
  const monitor = tool(buildMonitorTools({ scope: "manager", ...m }), "monitor");
  const result = await monitor.handler({ command: { run: "date", every: "5m" }, note: "x" }, toolContext({ threadId: thread.id, scope: managerScope(env.dir) }));
  expect(result.error).toContain("changed between two runs");
  expect(typeof result.output).toBe("string");
  expect(m.commandMonitorManager.list(thread.id)).toEqual([]);
  m.dispose();
});

test("list_my_monitors lists both kinds with their parameters, and only this thread's", async () => {
  const env = freshStoresEnv("md-mtools-list-");
  const projectId = seedProject(env.projects, { tmuxSessionName: "md-p" });
  const featureId = seedFeature(env.features, projectId, { tmuxWindowName: "f" });
  const a = env.agentStore.getOrCreateThread("manager", null);
  const b = env.agentStore.createManagerThread("other");
  const m = managers(env);
  const tools = buildMonitorTools({ scope: "manager", ...m, projectsStore: env.projects, featuresStore: env.features });
  const ctxA = toolContext({ threadId: a.id, scope: managerScope(env.dir) });
  const ctxB = toolContext({ threadId: b.id, scope: managerScope(env.dir) });
  const pane = await tool(tools, "monitor").handler({ pane: { paneId: "%1", featureId }, note: "build" }, ctxA);
  const command = await tool(tools, "monitor").handler({ command: { run: "echo 1", every: "5m", description: "  Count of one  " }, note: "x" }, ctxA);
  await tool(tools, "monitor").handler({ command: { run: "echo 2", every: "5m" }, note: "y" }, ctxB);
  const listed = (await tool(tools, "list_my_monitors").handler({}, ctxA)).monitors;
  expect(listed.map((x: { monitorId: string; kind: string }) => [x.monitorId, x.kind])).toEqual([[pane.monitorId, "pane"], [command.monitorId, "command"]]);
  // The whole field set of each kind, so a field silently dropping out shows.
  expect(Object.keys(listed[0]).sort()).toEqual(["createdAt", "kind", "monitorId", "note", "paneId", "timeoutAt", "unchangedFor", "windowKey"]);
  expect(listed[0]).toMatchObject({ paneId: "%1", windowKey: "md-p:f", unchangedFor: "30s", note: "build" });
  expect(Object.keys(listed[1]).sort()).toEqual(["command", "consecutiveFailures", "createdAt", "cwd", "description", "every", "kind", "lastRunAt", "monitorId", "nextRunAt", "note", "timeoutAt", "wakeWhen"]);
  expect(listed[1]).toMatchObject({ command: "echo 1", cwd: env.dir, every: "5m", wakeWhen: "changed", note: "x", consecutiveFailures: 0, description: "Count of one" });
  for (const entry of listed) {
    expect(Date.parse(entry.createdAt)).not.toBeNaN();
    expect(Date.parse(entry.timeoutAt)).not.toBeNaN();
  }
  expect((await tool(tools, "list_my_monitors").handler({}, ctxB)).monitors.map((x: { command?: string }) => x.command)).toEqual(["echo 2"]);
  m.dispose();
});

test("cancel_monitor cancels the monitor it names, of either kind, and refuses another thread's", async () => {
  const env = freshStoresEnv("md-mtools-cancel-");
  const projectId = seedProject(env.projects, { tmuxSessionName: "md-p" });
  const featureId = seedFeature(env.features, projectId, { tmuxWindowName: "f" });
  const a = env.agentStore.getOrCreateThread("manager", null);
  const b = env.agentStore.createManagerThread("other");
  const m = managers(env);
  const tools = buildMonitorTools({ scope: "manager", ...m, projectsStore: env.projects, featuresStore: env.features });
  const ctxA = toolContext({ threadId: a.id, scope: managerScope(env.dir) });
  const register = (args: object, ctx = ctxA) => tool(tools, "monitor").handler(args, ctx);
  const ids = async () => (await tool(tools, "list_my_monitors").handler({}, ctxA)).monitors.map((x: { monitorId: string }) => x.monitorId);
  // Two of each kind, cancelling the second registered of each: a handler
  // that cancelled the thread's first monitor instead would look the same
  // with a first-registered target.
  const pane1 = await register({ pane: { paneId: "%1", featureId }, note: "p1" });
  const pane2 = await register({ pane: { paneId: "%2", featureId }, note: "p2" });
  const command1 = await register({ command: { run: "echo 1", every: "5m" }, note: "c1" });
  const command2 = await register({ command: { run: "echo 2", every: "5m" }, note: "c2" });
  const theirs = await register({ command: { run: "echo 3", every: "5m" }, note: "t" }, toolContext({ threadId: b.id, scope: managerScope(env.dir) }));

  expect(await tool(tools, "cancel_monitor").handler({ monitorId: pane2.monitorId }, ctxA)).toEqual({ ok: true, monitorId: pane2.monitorId });
  expect(await ids()).toEqual([pane1.monitorId, command1.monitorId, command2.monitorId]);
  expect(await tool(tools, "cancel_monitor").handler({ monitorId: command2.monitorId }, ctxA)).toEqual({ ok: true, monitorId: command2.monitorId });
  expect(await ids()).toEqual([pane1.monitorId, command1.monitorId]);

  expect(await tool(tools, "cancel_monitor").handler({ monitorId: theirs.monitorId }, ctxA)).toEqual({ error: `monitor not found: ${theirs.monitorId}` });
  // A refusal, not a delete that also errored: it is still there for its owner.
  expect(m.commandMonitorManager.list(b.id).map((r) => r.id)).toEqual([theirs.monitorId]);
  m.dispose();
});

test("the monitor description teaches succeeds, stable output and || true", () => {
  const env = freshStoresEnv("md-mtools-desc-");
  const m = managers(env);
  const monitor = tool(buildMonitorTools({ scope: "worker", ...m }), "monitor");
  expect(monitor.description).toContain("succeeds");
  expect(monitor.description).toContain("never times or durations");
  expect(monitor.description).toContain("|| true");
  expect(monitor.description).toContain("Registering a monitor is an action");
  // A broken check looks like one still waiting: what the first run said, and
  // stderr on a failed run, tell them apart. No flag of one CLI as the example.
  expect(monitor.description).toContain("a check that cannot run looks like one still waiting");
  expect(monitor.description).toContain("send stderr to /dev/null");
  expect(monitor.description).not.toContain("--jq");
  m.dispose();
});

test("a command monitor's description is asked for the way bash asks for one, and is optional", () => {
  const env = freshStoresEnv("md-mtools-description-");
  const m = managers(env);
  const monitor = tool(buildMonitorTools({ scope: "worker", ...m }), "monitor");
  // Read as the model receives it: the JSON schema, narrowed to the part asked about.
  const schema = z.toJSONSchema(monitor.parameters) as unknown as { properties: { command: { properties: Record<string, { description?: string }>; required?: string[] } } };
  const asked = schema.properties.command.properties.description?.description ?? "";
  expect(asked).toMatch(/^What this command waits on/);
  expect(asked).toContain("in place of the command");
  expect(asked).toContain("5-10 words");
  expect(schema.properties.command.required ?? []).not.toContain("description");
  m.dispose();
});

// How long a pane's screen must stay unchanged is Mandate's, not the agent's:
// agents set it to how long the work would take (two wordings failed), and no
// other agent tool lets the model choose its quiet window.
test("the pane monitor waits 30s of an unchanged screen and offers no window to choose", () => {
  const env = freshStoresEnv("md-mtools-quiet-");
  const m = managers(env);
  for (const scope of ["worker", "manager"] as const) {
    const monitor = tool(buildMonitorTools({ scope, ...m }), "monitor");
    expect(monitor.description).toContain("- pane: wakes you when a tmux pane's screen has stayed unchanged for 30s. Use it after starting long-running work in a pane: a program at work keeps its screen changing, so this suits long work too.\n");
    expect(monitor.description).not.toContain("unchangedFor");
    const schema = z.toJSONSchema(monitor.parameters) as unknown as { properties: { pane: { description?: string; properties: Record<string, { description?: string }> } } };
    expect(schema.properties.pane.description).toBe("Wake when this tmux pane's screen has been unchanged for 30s.");
    expect(["unchangedFor", "quietFor"].map((name) => name in schema.properties.pane.properties)).toEqual([false, false]);
    expect(monitor.description).not.toContain("no content changes");
    // An agent copying an old call of its own (unchangedFor, or quietFor
    // before that) is not refused: the old key is dropped, and it waits the
    // 30s as any other does.
    for (const old of [{ unchangedFor: "4m" }, { quietFor: "4m" }]) {
      expect(monitor.parameters.parse({ pane: { paneId: "%1", ...old }, note: "build" })).toEqual({ pane: { paneId: "%1" }, note: "build" });
    }
  }
  m.dispose();
});
