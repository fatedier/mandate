import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { buildPaneRuntimes } from "../src/server/runtime/pane-runtime-registry.js";
import { seedFeature, seedProject } from "../tests/helpers/fixtures.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { freshRealTmuxProjectEnv } from "./helpers/fixtures.js";
import { reconcileProject } from "../src/server/modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../src/server/modules/projects/tmux-reconcile-adapter.js";
import { tmuxCommand, tmuxNewWindow } from "../src/server/platform/tmux/tmux.js";
import { TmuxPipeManager } from "../src/server/runtime/runtimes/tmux-pipe-manager.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The message a promise is refused with (awaited, as e2e assertions are). */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "(resolved)", (error: unknown) => (error instanceof Error ? error.message : String(error)));
}

const TEST_FIT_RESTORE_GRACE_MS = 20;

function makeRuntime(env: ReturnType<typeof freshRealTmuxProjectEnv>) {
  return new TmuxRuntime({
    tmuxClient: env.tmux.client,
    projectsStore: env.projects,
    featuresStore: env.features,
    fitRestoreGraceMs: TEST_FIT_RESTORE_GRACE_MS
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForFitRestore() {
  return wait(TEST_FIT_RESTORE_GRACE_MS + 40);
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  let lastValue: T | undefined;
  try {
    const { value } = await waitUntil(async () => {
      lastValue = await read();
      return predicate(lastValue) ? { value: lastValue } : null;
    }, { timeout: opts.timeoutMs ?? 3000, interval: opts.intervalMs ?? 50, label: opts.label });
    return value;
  } catch (error) {
    throw new Error(`${(error as Error).message}; last value: ${String(lastValue)}`);
  }
}

function tmuxWindowSize(env: ReturnType<typeof freshRealTmuxProjectEnv>, target: string): { width: number; height: number } {
  const r = spawnSync(
    "tmux",
    [
      ...env.tmux.client.socketArgs,
      "display-message",
      "-p",
      "-t",
      target,
      "#{window_width} #{window_height}"
    ],
    { encoding: "utf8", timeout: 1000 }
  );
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(0);
  const [width, height] = String(r.stdout || "").trim().split(/\s+/).map(Number);
  return { width, height };
}

function tmuxPaneSize(env: ReturnType<typeof freshRealTmuxProjectEnv>, target: string): { width: number; height: number } {
  const r = spawnSync(
    "tmux",
    [
      ...env.tmux.client.socketArgs,
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_width} #{pane_height}"
    ],
    { encoding: "utf8", timeout: 1000 }
  );
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(0);
  const [width, height] = String(r.stdout || "").trim().split(/\s+/).map(Number);
  return { width, height };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function respawnPaneWithShellScript(
  env: ReturnType<typeof freshRealTmuxProjectEnv>,
  paneId: string,
  script: string
): void {
  const r = tmuxCommand(
    env.tmux.client,
    ["respawn-pane", "-k", "-t", paneId, `/bin/sh -lc ${shellSingleQuote(script)}`],
    { timeout: 2500 }
  );
  expect(r.status).toBe(0);
}

test("TmuxRuntime.listPanes: returns panes from a real tmux window", async () => {
  const env = freshRealTmuxProjectEnv("md-tmrt-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-tmrt"
    });
    seedFeature(env.features, projectId, { name: "feat-A", tmuxWindowName: "feat-a" });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-tmrt", "feat-a", env.dir, env.tmux.client);

    const features = env.features.listActiveByProject(projectId);
    const panes = await makeRuntime(env).listPanes(features[0]!.id);
    expect(panes.length).toBeGreaterThan(0);
    expect(panes[0]!.featureId).toBe(features[0]!.id);
    expect(panes[0]!.id).toMatch(/^%/);  // tmux pane ids start with %
  } finally { env.cleanup(); }
});

test("TmuxRuntime.spawnPane: creates a shell pane when no command is provided", async () => {
  const env = freshRealTmuxProjectEnv("md-tmrt-sp-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-tmrt-sp"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "feat-A", tmuxWindowName: "feat-a"
    });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-tmrt-sp", "feat-a", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const originalPane = (await rt.listPanes(featureId))[0]!;
    const originalSize = tmuxPaneSize(env, originalPane.id);
    const pane = await rt.spawnPane({ featureId, cwd: env.dir });
    expect(pane.id).toMatch(/^%/);
    expect(pane.command).toEqual([]);
    const panes = await rt.listPanes(featureId);
    expect(panes.some((p) => p.id === pane.id)).toBe(true);
    expect(tmuxPaneSize(env, pane.id).height).toBe(originalSize.height);
    expect(tmuxPaneSize(env, pane.id).width).toBeLessThan(originalSize.width);
  } finally { env.cleanup(); }
});

test("TmuxRuntime.spawnPane: respects target pane and split direction", async () => {
  const env = freshRealTmuxProjectEnv("md-tmrt-sp-dir-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-tmrt-sp-dir"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "feat-A", tmuxWindowName: "feat-a"
    });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-tmrt-sp-dir", "feat-a", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const target = (await rt.listPanes(featureId))[0]!;
    const originalSize = tmuxPaneSize(env, target.id);
    const pane = await rt.spawnPane({
      featureId,
      cwd: env.dir,
      targetPaneId: target.id,
      direction: "down"
    });

    expect(tmuxPaneSize(env, target.id).width).toBe(originalSize.width);
    expect(tmuxPaneSize(env, pane.id).width).toBe(originalSize.width);
    expect(tmuxPaneSize(env, pane.id).height).toBeLessThan(originalSize.height);
    expect(await rejectionOf(rt.spawnPane({
      featureId,
      cwd: env.dir,
      targetPaneId: "%999",
      direction: "right"
    }))).toMatch(/target pane %999 is not in/);
  } finally { env.cleanup(); }
});

/** A viewer attached to a fresh pane, its live output seen once. */
async function attachedViewer(name: string) {
  const env = freshRealTmuxProjectEnv(`md-${name}-`);
  const projectId = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: `alpha-${name}` });
  seedFeature(env.features, projectId, { name: `f-${name}`, tmuxWindowName: `f-${name}` });
  reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
  tmuxNewWindow(`alpha-${name}`, `f-${name}`, env.dir, env.tmux.client);
  const rt = makeRuntime(env);
  const pane = (await rt.listPanes(env.features.listActiveByProject(projectId)[0]!.id))[0]!;
  const received: Uint8Array[] = [];
  const ws: any = { readyState: 1, send: (chunk: Uint8Array) => received.push(chunk), close: () => {} };
  const handle = await rt.attachViewer(pane.id, ws, { cols: 80, rows: 24 });
  await handle.ready;
  const text = () => Buffer.concat(received.map((u) => Buffer.from(u))).toString("utf8");
  const type = async (line: string) => { await rt.sendKeys(pane.id, ["-l", line]); await rt.sendKeys(pane.id, ["Enter"]); };
  await type("echo before pipe stop");
  await waitFor(text, (value) => /before pipe stop/.test(value), { label: "initial pipe output" });
  /** This process's fifo for the pane. */
  const fifo = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`mandate-pipe-${process.pid}-`)).map((f) => path.join(os.tmpdir(), f));
  /** tmux stops the pipe (as `pipe-pane` with no command does); what is typed after comes back live. */
  const stopThenType = async () => {
    expect(tmuxCommand(env.tmux.client, ["pipe-pane", "-t", pane.id], { timeout: 1000 }).status).toBe(0);
    await wait(250);
    await type("echo after pipe rearm");
    return waitFor(text, (value) => /after pipe rearm/.test(value), { label: "rearmed pipe output" });
  };
  return { env, handle, fifo, stopThenType };
}

test("TmuxRuntime.attachViewer: a live pipe outlasts another Mandate starting beside it", async () => {
  const v = await attachedViewer("attach-sweep");
  try {
    const mine = v.fifo();
    expect(mine).toHaveLength(1);
    // Another Mandate process on the same machine clears leftovers at startup.
    new TmuxPipeManager({ tmuxClient: v.env.tmux.client, pipeDir: os.tmpdir(), pipePrefix: "mandate-pipe-1" }).sweepStalePipes();
    expect(v.fifo()).toEqual(mine);
    expect(await v.stopThenType()).toMatch(/after pipe rearm/);
    v.handle.detach();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime.attachViewer: a pipe whose fifo was removed meanwhile is re-armed into a new one", async () => {
  const v = await attachedViewer("attach-refifo");
  try {
    for (const file of v.fifo()) fs.unlinkSync(file); // a temp cleaner, say
    expect(await v.stopThenType()).toMatch(/after pipe rearm/);
    v.handle.detach();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime.sendKeys: passes raw tmux args and rejects target overrides", async () => {
  const env = freshRealTmuxProjectEnv("md-sendkeys-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-sendkeys"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "feat-A", tmuxWindowName: "feat-a"
    });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-sendkeys", "feat-a", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const pane = (await rt.listPanes(featureId))[0]!;
    await wait(500);
    await rt.sendKeys(pane.id, ["-l", "printf 'literal:%s\\n' 'hello world'"]);
    await rt.sendKeys(pane.id, ["Enter"]);
    const output = await waitFor(
      () => rt.readScrollback(pane.id, { tailLines: 20 }),
      (value) => value.includes("literal:hello world"),
      { label: "literal send-keys output" }
    );
    expect(output).toContain("literal:hello world");
    expect(await rejectionOf(rt.sendKeys(pane.id, ["-t", "%999", "Enter"]))).toMatch(/target is managed/);
    await rt.sendKeys(pane.id, ["-l", "--", "-target-looking literal"]);
    await rt.sendKeys(pane.id, ["C-u"]);
  } finally { env.cleanup(); }
});

test("TmuxRuntime fit lease: newest pane owner wins and stale viewers cannot resize", async () => {
  const env = freshRealTmuxProjectEnv("md-fit-owner-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-fit-owner"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "f-fit-owner", tmuxWindowName: "f-fit-owner"
    });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-fit-owner", "f-fit-owner", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const paneA = (await rt.listPanes(featureId))[0]!;
    const paneB = await rt.spawnPane({ featureId, cwd: env.dir });
    const original = tmuxWindowSize(env, paneA.id);
    const geometry = { cols: original.width, rows: original.height };

    const wsA: any = { readyState: 1, send: () => {}, close: () => {} };
    const wsB: any = { readyState: 1, send: () => {}, close: () => {} };
    const handleA = await rt.attachViewer(paneA.id, wsA, geometry);
    const handleB = await rt.attachViewer(paneB.id, wsB, geometry);

    handleA.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 90, rows: 30 }));
    expect(tmuxWindowSize(env, paneA.id)).toEqual({ width: 90, height: 30 });

    handleB.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 100, rows: 35 }));
    expect(tmuxWindowSize(env, paneB.id)).toEqual({ width: 100, height: 35 });

    handleA.handleMessage(JSON.stringify({ type: "resize", cols: 70, rows: 20 }));
    expect(tmuxWindowSize(env, paneB.id)).toEqual({ width: 100, height: 35 });

    handleB.detach();
    await waitForFitRestore();
    expect(tmuxWindowSize(env, paneA.id)).toEqual(original);
    handleA.detach();
  } finally { env.cleanup(); }
});

test("TmuxRuntime fit lease: pane switch cancels pending restore", async () => {
  const env = freshRealTmuxProjectEnv("md-fit-switch-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-fit-switch"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "f-fit-switch", tmuxWindowName: "f-fit-switch"
    });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-fit-switch", "f-fit-switch", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const paneA = (await rt.listPanes(featureId))[0]!;
    const paneB = await rt.spawnPane({ featureId, cwd: env.dir });
    const original = tmuxWindowSize(env, paneA.id);

    const wsA: any = { readyState: 1, send: () => {}, close: () => {} };
    const handleA = await rt.attachViewer(paneA.id, wsA, { cols: 90, rows: 30 }, { fit: true });
    expect(tmuxWindowSize(env, paneA.id)).toEqual({ width: 90, height: 30 });

    handleA.detach();
    expect(tmuxWindowSize(env, paneA.id)).toEqual({ width: 90, height: 30 });

    const wsB: any = { readyState: 1, send: () => {}, close: () => {} };
    const handleB = await rt.attachViewer(paneB.id, wsB, { cols: 100, rows: 35 }, { fit: true });
    await waitForFitRestore();
    expect(tmuxWindowSize(env, paneB.id)).toEqual({ width: 100, height: 35 });

    handleB.detach();
    await waitForFitRestore();
    expect(tmuxWindowSize(env, paneA.id)).toEqual(original);
  } finally { env.cleanup(); }
});

test("TmuxRuntime fit attach: initial capture keeps scrollback", async () => {
  const env = freshRealTmuxProjectEnv("md-fit-visible-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-fit-visible"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "f-fit-visible", tmuxWindowName: "f-fit-visible"
    });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-fit-visible", "f-fit-visible", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const pane = (await rt.listPanes(featureId))[0]!;
    respawnPaneWithShellScript(
      env,
      pane.id,
      `i=1; while [ "$i" -le 50 ]; do printf "fit-visible-%02d\\n" "$i"; i=$((i + 1)); done; exec /bin/sh`
    );
    await waitFor(
      () => rt.readScrollback(pane.id, { tailLines: 80 }),
      (value) => value.includes("fit-visible-49"),
      { label: "tmux generated scrollback" }
    );

    const sent: string[] = [];
    const ws: any = { readyState: 1, send: (chunk: string) => sent.push(String(chunk)), close: () => {} };
    const handle = await rt.attachViewer(pane.id, ws, { cols: 90, rows: 12 }, { fit: true, historyRows: 1000 });
    const initial = await waitFor(
      () => sent[0] ?? "",
      (value) => value.includes("fit-visible-01") && value.includes("fit-visible-49"),
      { timeoutMs: 4000, label: "tmux fit initial capture" }
    );

    expect(initial).toContain("fit-visible-01");
    expect(initial).toContain("fit-visible-49");

    handle.detach();
    await waitForFitRestore();
  } finally { env.cleanup(); }
});

test("buildPaneRuntimes: forProject returns tmux runtime for a known project", () => {
  const env = freshRealTmuxProjectEnv("md-pr-reg-");
  try {
    const tmuxId = seedProject(env.projects, {
      name: "tmux-proj", workingDir: env.dir,
      tmuxSessionName: "tmpr-tmux"
    });
    const reg = buildPaneRuntimes({
      tmuxClient: env.tmux.client,
      projectsStore: env.projects,
      featuresStore: env.features
    });
    expect(reg.forProject(tmuxId)).toBe(reg.tmux);
    expect(() => reg.forProject("nope")).toThrow(/project nope/i);
  } finally { env.cleanup(); }
});
