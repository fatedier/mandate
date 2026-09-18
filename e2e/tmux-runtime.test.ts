import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { buildPaneRuntimes } from "../src/server/runtime/pane-runtime-registry.js";
import { seedFeature, seedProject } from "../tests/helpers/fixtures.js";
import { freshRealTmuxProjectEnv } from "./helpers/fixtures.js";
import { reconcileProject } from "../src/server/modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../src/server/modules/projects/tmux-reconcile-adapter.js";
import { tmuxCommand, tmuxNewWindow } from "../src/server/platform/tmux/tmux.js";

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
  const timeoutMs = opts.timeoutMs ?? 3000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() <= deadline) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    await wait(intervalMs);
  }
  throw new Error(`timed out waiting for ${opts.label ?? "condition"}; last value: ${String(lastValue)}`);
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

test("TmuxRuntime: kind === 'tmux'", () => {
  const env = freshRealTmuxProjectEnv("md-tmrt-");
  try {
    const rt = makeRuntime(env);
    expect(rt.kind).toBe("tmux");
  } finally { env.cleanup(); }
});

test("TmuxRuntime.init: returns empty map (tmux has no orphans)", async () => {
  const env = freshRealTmuxProjectEnv("md-tmrt-");
  try {
    const rt = makeRuntime(env);
    const orphans = await rt.init();
    expect(orphans.size).toBe(0);
  } finally { env.cleanup(); }
});

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
    await expect(rt.spawnPane({
      featureId,
      cwd: env.dir,
      targetPaneId: "%999",
      direction: "right"
    })).rejects.toThrow(/target pane %999 is not in/);
  } finally { env.cleanup(); }
});

test("TmuxRuntime.attachViewer: streams pane bytes to a mock WS and forwards keystrokes", async () => {
  const env = freshRealTmuxProjectEnv("md-attach-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-attach"
    });
    seedFeature(env.features, projectId, { name: "f-attach", tmuxWindowName: "f-attach" });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-attach", "f-attach", env.dir, env.tmux.client);
    const features = env.features.listActiveByProject(projectId);
    const panes = await new TmuxRuntime({
      tmuxClient: env.tmux.client,
      projectsStore: env.projects,
      featuresStore: env.features
    }).listPanes(features[0]!.id);
    const paneId = panes[0]!.id;

    const rt = new TmuxRuntime({
      tmuxClient: env.tmux.client,
      projectsStore: env.projects,
      featuresStore: env.features
    });

    const received: Uint8Array[] = [];
    const mockWs: any = {
      readyState: 1,
      send: (chunk: Uint8Array) => received.push(chunk),
      close: () => {}
    };
    const handle = await rt.attachViewer(paneId, mockWs, { cols: 80, rows: 24 });

    await handle.ready;

    // Trigger output in the pane via send-keys. Literal mode must preserve
    // spaces instead of splitting the command into tmux key tokens.
    await rt.sendKeys(paneId, ["-l", "echo hello attach"]);
    await rt.sendKeys(paneId, ["Enter"]);
    const all = await waitFor(
      () => Buffer.concat(received.map((u) => Buffer.from(u))).toString("utf8"),
      (value) => /hello attach/.test(value),
      { label: "tmux pipe output" }
    );
    expect(all).toMatch(/hello attach/);

    handle.detach();
  } finally { env.cleanup(); }
});

test("TmuxRuntime.attachViewer: re-arms live output after tmux pipe-pane stops", async () => {
  const env = freshRealTmuxProjectEnv("md-attach-rearm-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-attach-rearm"
    });
    seedFeature(env.features, projectId, { name: "f-attach-rearm", tmuxWindowName: "f-attach-rearm" });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-attach-rearm", "f-attach-rearm", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const pane = (await rt.listPanes(env.features.listActiveByProject(projectId)[0]!.id))[0]!;
    const received: Uint8Array[] = [];
    const ws: any = {
      readyState: 1,
      send: (chunk: Uint8Array) => received.push(chunk),
      close: () => {}
    };
    const handle = await rt.attachViewer(pane.id, ws, { cols: 80, rows: 24 });
    await handle.ready;

    await rt.sendKeys(pane.id, ["-l", "echo before pipe stop"]);
    await rt.sendKeys(pane.id, ["Enter"]);
    await waitFor(
      () => Buffer.concat(received.map((u) => Buffer.from(u))).toString("utf8"),
      (value) => /before pipe stop/.test(value),
      { label: "initial pipe output" }
    );

    const stop = tmuxCommand(env.tmux.client, ["pipe-pane", "-t", pane.id], { timeout: 1000 });
    expect(stop.status).toBe(0);
    await wait(250);

    await rt.sendKeys(pane.id, ["-l", "echo after pipe rearm"]);
    await rt.sendKeys(pane.id, ["Enter"]);
    const all = await waitFor(
      () => Buffer.concat(received.map((u) => Buffer.from(u))).toString("utf8"),
      (value) => /after pipe rearm/.test(value),
      { label: "rearmed pipe output" }
    );
    expect(all).toMatch(/after pipe rearm/);

    handle.detach();
  } finally { env.cleanup(); }
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
    await expect(rt.sendKeys(pane.id, ["-t", "%999", "Enter"])).rejects.toThrow(/target is managed/);
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

test("TmuxRuntime fit lease: initial fit applies before viewer attach returns", async () => {
  const env = freshRealTmuxProjectEnv("md-fit-initial-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-fit-initial"
    });
    const featureId = seedFeature(env.features, projectId, {
      name: "f-fit-initial", tmuxWindowName: "f-fit-initial"
    });
    const project = env.projects.getById(projectId)!;
    reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    tmuxNewWindow("alpha-fit-initial", "f-fit-initial", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const pane = (await rt.listPanes(featureId))[0]!;
    const original = tmuxWindowSize(env, pane.id);
    const ws: any = { readyState: 1, send: () => {}, close: () => {} };
    const handle = await rt.attachViewer(pane.id, ws, { cols: 111, rows: 37 }, { fit: true });

    expect(tmuxWindowSize(env, pane.id)).toEqual({ width: 111, height: 37 });

    handle.detach();
    await waitForFitRestore();
    expect(tmuxWindowSize(env, pane.id)).toEqual(original);
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
    expect(reg.forProject(tmuxId).kind).toBe("tmux");
    expect(() => reg.forProject("nope")).toThrow(/project nope/i);
  } finally { env.cleanup(); }
});
