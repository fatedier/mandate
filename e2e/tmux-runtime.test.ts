import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { seedWorker, seedProject } from "../tests/helpers/fixtures.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { freshRealTmuxProjectEnv } from "./helpers/fixtures.js";
import { startTestTmuxServer } from "./helpers/tmux-server.js";
import { reconcileProject } from "../src/server/modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../src/server/modules/projects/tmux-reconcile-adapter.js";
import { tmuxCommand, tmuxListSessionsWithWindows, tmuxNewSession, tmuxNewWindow } from "../src/server/platform/tmux/tmux.js";
import { TmuxPipeManager } from "../src/server/runtime/runtimes/tmux-pipe-manager.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeCommandRunner, type CommandRunOptions } from "../src/server/platform/process/command-runner.js";

/** The message a promise is refused with (awaited, as e2e assertions are). */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "(resolved)", (error: unknown) => (error instanceof Error ? error.message : String(error)));
}

const TEST_FIT_RESTORE_GRACE_MS = 20;

function makeRuntime(env: ReturnType<typeof freshRealTmuxProjectEnv>) {
  return new TmuxRuntime({
    tmuxClient: env.tmux.client,
    projectsStore: env.projects,
    workersStore: env.workers,
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

/** Until the pane's shell has drawn its prompt, so what is typed next reaches
 *  a shell that reads it. */
async function promptDrawn(env: ReturnType<typeof freshRealTmuxProjectEnv>, paneId: string): Promise<void> {
  await waitFor(
    async () => (await tmuxCommand(env.tmux.client, ["capture-pane", "-p", "-t", paneId], { timeout: 1000 })).stdout.trim(),
    (shown) => shown.length > 0,
    { label: "the pane's prompt" }
  );
}

/** The size tmux gives the target's window or pane, read straight from tmux. */
function tmuxSize(env: ReturnType<typeof freshRealTmuxProjectEnv>, target: string, of: "window" | "pane"): { width: number; height: number } {
  const r = spawnSync(
    "tmux",
    [...env.tmux.client.socketArgs, "display-message", "-p", "-t", target, `#{${of}_width} #{${of}_height}`],
    { encoding: "utf8", timeout: 1000 }
  );
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(0);
  const [width, height] = String(r.stdout || "").trim().split(/\s+/).map(Number);
  return { width, height };
}
const tmuxWindowSize = (env: ReturnType<typeof freshRealTmuxProjectEnv>, target: string) => tmuxSize(env, target, "window");
const tmuxPaneSize = (env: ReturnType<typeof freshRealTmuxProjectEnv>, target: string) => tmuxSize(env, target, "pane");

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function respawnPaneWithShellScript(
  env: ReturnType<typeof freshRealTmuxProjectEnv>,
  paneId: string,
  script: string
): Promise<void> {
  const r = await tmuxCommand(
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
    seedWorker(env.workers, projectId, { name: "wkr-A", tmuxWindowName: "wkr-a" });
    const project = env.projects.getById(projectId)!;
    await reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-tmrt", "wkr-a", env.dir, env.tmux.client);

    const workers = env.workers.listActiveByProject(projectId);
    const panes = await makeRuntime(env).listPanes(workers[0]!.id);
    expect(panes.length).toBeGreaterThan(0);
    expect(panes[0]!.workerId).toBe(workers[0]!.id);
    expect(panes[0]!.id).toMatch(/^%/);  // tmux pane ids start with %
  } finally { env.cleanup(); }
});

test("TmuxRuntime.spawnPane: creates a shell pane when no command is provided", async () => {
  const env = freshRealTmuxProjectEnv("md-tmrt-sp-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-tmrt-sp"
    });
    const workerId = seedWorker(env.workers, projectId, {
      name: "wkr-A", tmuxWindowName: "wkr-a"
    });
    const project = env.projects.getById(projectId)!;
    await reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-tmrt-sp", "wkr-a", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const originalPane = (await rt.listPanes(workerId))[0]!;
    const originalSize = tmuxPaneSize(env, originalPane.id);
    const pane = await rt.spawnPane({ workerId, cwd: env.dir });
    expect(pane.id).toMatch(/^%/);
    expect(pane.command).toEqual([]);
    const panes = await rt.listPanes(workerId);
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
    const workerId = seedWorker(env.workers, projectId, {
      name: "wkr-A", tmuxWindowName: "wkr-a"
    });
    const project = env.projects.getById(projectId)!;
    await reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-tmrt-sp-dir", "wkr-a", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const target = (await rt.listPanes(workerId))[0]!;
    const originalSize = tmuxPaneSize(env, target.id);
    const pane = await rt.spawnPane({
      workerId,
      cwd: env.dir,
      targetPaneId: target.id,
      direction: "down"
    });

    expect(tmuxPaneSize(env, target.id).width).toBe(originalSize.width);
    expect(tmuxPaneSize(env, pane.id).width).toBe(originalSize.width);
    expect(tmuxPaneSize(env, pane.id).height).toBeLessThan(originalSize.height);
    expect(await rejectionOf(rt.spawnPane({
      workerId,
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
  seedWorker(env.workers, projectId, { name: `f-${name}`, tmuxWindowName: `f-${name}` });
  await reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
  await tmuxNewWindow(`alpha-${name}`, `f-${name}`, env.dir, env.tmux.client);
  const rt = makeRuntime(env);
  const pane = (await rt.listPanes(env.workers.listActiveByProject(projectId)[0]!.id))[0]!;
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
    expect((await tmuxCommand(env.tmux.client, ["pipe-pane", "-t", pane.id], { timeout: 1000 })).status).toBe(0);
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
    await new TmuxPipeManager({ tmuxClient: v.env.tmux.client, pipeDir: os.tmpdir(), pipePrefix: "mandate-pipe-1" }).sweepStalePipes();
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
    const workerId = seedWorker(env.workers, projectId, {
      name: "wkr-A", tmuxWindowName: "wkr-a"
    });
    const project = env.projects.getById(projectId)!;
    await reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-sendkeys", "wkr-a", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const pane = (await rt.listPanes(workerId))[0]!;
    await promptDrawn(env, pane.id);
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
    const workerId = seedWorker(env.workers, projectId, {
      name: "f-fit-owner", tmuxWindowName: "f-fit-owner"
    });
    const project = env.projects.getById(projectId)!;
    await reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-fit-owner", "f-fit-owner", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const paneA = (await rt.listPanes(workerId))[0]!;
    const paneB = await rt.spawnPane({ workerId, cwd: env.dir });
    const original = tmuxWindowSize(env, paneA.id);
    const geometry = { cols: original.width, rows: original.height };

    const wsA: any = { readyState: 1, send: () => {}, close: () => {} };
    const wsB: any = { readyState: 1, send: () => {}, close: () => {} };
    const handleA = await rt.attachViewer(paneA.id, wsA, geometry);
    const handleB = await rt.attachViewer(paneB.id, wsB, geometry);

    await handleA.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 90, rows: 30 }));
    expect(tmuxWindowSize(env, paneA.id)).toEqual({ width: 90, height: 30 });

    await handleB.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 100, rows: 35 }));
    expect(tmuxWindowSize(env, paneB.id)).toEqual({ width: 100, height: 35 });

    await handleA.handleMessage(JSON.stringify({ type: "resize", cols: 70, rows: 20 }));
    expect(tmuxWindowSize(env, paneB.id)).toEqual({ width: 100, height: 35 });

    // B gone, the window goes back to A, whose fit B took; A gone, it is
    // put back as it was.
    handleB.detach();
    await waitForFitRestore();
    expect(tmuxWindowSize(env, paneA.id)).toEqual({ width: 90, height: 30 });
    handleA.detach();
    await waitForFitRestore();
    expect(tmuxWindowSize(env, paneA.id)).toEqual(original);
  } finally { env.cleanup(); }
});

test("TmuxRuntime fit lease: pane switch cancels pending restore", async () => {
  const env = freshRealTmuxProjectEnv("md-fit-switch-");
  try {
    const projectId = seedProject(env.projects, {
      name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-fit-switch"
    });
    const workerId = seedWorker(env.workers, projectId, {
      name: "f-fit-switch", tmuxWindowName: "f-fit-switch"
    });
    const project = env.projects.getById(projectId)!;
    await reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-fit-switch", "f-fit-switch", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const paneA = (await rt.listPanes(workerId))[0]!;
    const paneB = await rt.spawnPane({ workerId, cwd: env.dir });
    const original = tmuxWindowSize(env, paneA.id);

    const wsA: any = { readyState: 1, send: () => {}, close: () => {} };
    const handleA = rt.attachViewer(paneA.id, wsA, { cols: 90, rows: 30 }, { fit: true });
    // The lease is taken in the pane's turn, just after the handle comes back.
    await waitFor(() => JSON.stringify(tmuxWindowSize(env, paneA.id)), (size) => size === JSON.stringify({ width: 90, height: 30 }), { label: "fitted window" });

    handleA.detach();
    expect(tmuxWindowSize(env, paneA.id)).toEqual({ width: 90, height: 30 });

    const wsB: any = { readyState: 1, send: () => {}, close: () => {} };
    const handleB = rt.attachViewer(paneB.id, wsB, { cols: 100, rows: 35 }, { fit: true });
    // B's lease is taken in its pane's turn; A's restore, still pending,
    // must not undo it once its grace has passed.
    await waitFor(() => JSON.stringify(tmuxWindowSize(env, paneB.id)), (size) => size === JSON.stringify({ width: 100, height: 35 }), { label: "B's fitted window" });
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
    const workerId = seedWorker(env.workers, projectId, {
      name: "f-fit-visible", tmuxWindowName: "f-fit-visible"
    });
    const project = env.projects.getById(projectId)!;
    await reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-fit-visible", "f-fit-visible", env.dir, env.tmux.client);

    const rt = makeRuntime(env);
    const pane = (await rt.listPanes(workerId))[0]!;
    await respawnPaneWithShellScript(
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

test("TmuxRuntime.attachViewer: a viewer gone before its pipe was set up leaves no pipe or fifo behind", async () => {
  const env = freshRealTmuxProjectEnv("md-attach-gone-");
  try {
    const projectId = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-attach-gone" });
    const workerId = seedWorker(env.workers, projectId, { name: "f-gone", tmuxWindowName: "f-gone" });
    await reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-attach-gone", "f-gone", env.dir, env.tmux.client);
    const rt = makeRuntime(env);
    const pane = (await rt.listPanes(workerId))[0]!;
    const ws: any = { readyState: 1, send: () => {}, close: () => {} };
    // This test's own fifos: pane ids repeat across the tests' tmux servers,
    // and another test in this process may have left one.
    const earlierFifos = new Set(fs.readdirSync(os.tmpdir()));
    const handle = await rt.attachViewer(pane.id, ws, { cols: 80, rows: 24 });
    // Gone at once: its pipe's setup is still waiting its turn.
    handle.detach();
    await handle.ready;
    const piped = async () => (await tmuxCommand(env.tmux.client, ["display-message", "-p", "-t", pane.id, "#{pane_pipe}"], { timeout: 1000 })).stdout.trim();
    const fifos = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`mandate-pipe-${process.pid}-`) && !earlierFifos.has(f));
    await waitFor(async () => `${await piped()} ${fifos().length}`, (value) => value === "0 0", { label: "pipe taken down" });
  } finally { env.cleanup(); }
});

test("TmuxRuntime.attachViewer: what is typed before the viewer's pipe is armed still comes back live", async () => {
  // tmux slow to arm the pipe: the gap in which typed input once ran ahead of it.
  const v = await viewerFixture("attach-early-input", slowPipeArm);
  try {
    const handle = await v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 });
    void handle.handleMessage(JSON.stringify({ type: "input", data: "printf 'early-%s\\n' marker\r" }));
    expect(await waitFor(v.text, (value) => value.includes("early-marker"), { timeoutMs: 4000, label: "early input's output" })).toContain("early-marker");
    handle.detach();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime.attachViewer: with a fit, what is typed after the first paint and before the pipe is armed still comes back live", async () => {
  const v = await viewerFixture("attach-fit-input", slowPipeArm);
  try {
    const handle = await v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await waitFor(() => v.text().length, (count) => count > 0, { timeoutMs: 4000, label: "first fitted paint" });
    void handle.handleMessage(JSON.stringify({ type: "input", data: "printf 'fitted-%s\\n' marker\r" }));
    expect(await waitFor(v.text, (value) => value.includes("fitted-marker"), { timeoutMs: 4000, label: "input's output after the paint" })).toContain("fitted-marker");
    handle.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

/** The test's real tmux, with chosen commands made slow: `before` delays a
 *  command before it runs, `after` delays its answer after it ran. */
function slowTmux(env: ReturnType<typeof freshRealTmuxProjectEnv>, slow: (args: string[]) => { before?: number; after?: number } | null, sent?: string[][]) {
  return {
    socketArgs: env.tmux.client.socketArgs,
    runner: {
      run: async (command: string, args: string[], options?: CommandRunOptions) => {
        const delay = slow(args);
        if (delay?.before) await wait(delay.before);
        const answer = await nodeCommandRunner.run(command, args, options);
        if (args.includes("send-keys")) sent?.push(args.slice(args.indexOf("send-keys") + 1));
        if (delay?.after) await wait(delay.after);
        return answer;
      }
    }
  };
}

/** tmux slow to arm a pipe (`pipe-pane -O`), by 400 ms. */
const slowPipeArm = (env: ReturnType<typeof freshRealTmuxProjectEnv>) => slowTmux(env, (args) => args.includes("pipe-pane") && args.includes("-O") ? { before: 400 } : null);

async function viewerFixture(name: string, tmuxFor: (env: ReturnType<typeof freshRealTmuxProjectEnv>) => ConstructorParameters<typeof TmuxRuntime>[0]["tmuxClient"]) {
  const env = freshRealTmuxProjectEnv(`md-${name}-`);
  const projectId = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: `alpha-${name}` });
  const workerId = seedWorker(env.workers, projectId, { name: `f-${name}`, tmuxWindowName: `f-${name}` });
  await reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
  await tmuxNewWindow(`alpha-${name}`, `f-${name}`, env.dir, env.tmux.client);
  const rt = new TmuxRuntime({ tmuxClient: tmuxFor(env), projectsStore: env.projects, workersStore: env.workers, fitRestoreGraceMs: TEST_FIT_RESTORE_GRACE_MS });
  const pane = (await rt.listPanes(workerId))[0]!;
  await promptDrawn(env, pane.id);
  const { ws, text } = recordingViewer();
  return { env, rt, pane, ws, text, workerId };
}

/** The give-back notices a viewer was sent on its socket (control frames:
 *  text that starts with NUL). */
function givenBackTold(received: string): unknown[] {
  return received.split("\u0000").slice(1).map((part) => JSON.parse(part.slice(0, part.indexOf("}") + 1)) as unknown).filter((m) => (m as { type?: string }).type === "given-back");
}

/** A viewer's socket that keeps what it is sent. */
function recordingViewer() {
  const received: Uint8Array[] = [];
  const ws: any = { readyState: 1, send: (chunk: Uint8Array | string) => received.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk), close: () => {} };
  const text = () => Buffer.concat(received.map((u) => Buffer.from(u))).toString("utf8");
  return { ws, text };
}

/** The test's real tmux, every command it is asked kept in `asked`. */
function askedTmux(env: ReturnType<typeof freshRealTmuxProjectEnv>, asked: string[][]) {
  return {
    socketArgs: env.tmux.client.socketArgs,
    runner: {
      run: async (command: string, args: string[], options?: CommandRunOptions) => {
        asked.push(args);
        return nodeCommandRunner.run(command, args, options);
      }
    }
  };
}

/** A second pane in the fixture's window, its prompt drawn. */
async function secondPane(v: Awaited<ReturnType<typeof viewerFixture>>) {
  const pane = await v.rt.spawnPane({ workerId: v.workerId, cwd: v.env.dir });
  await promptDrawn(v.env, pane.id);
  return pane;
}

// A terminal kept hidden behind another tab keeps its fit; shown again, it
// asks for it once more.
test("TmuxRuntime: a fit asked again by the viewer holding it, at its size, is answered without asking tmux anything", async () => {
  const asked: string[][] = [];
  const v = await viewerFixture("fit-again", (env) => askedTmux(env, asked));
  try {
    const handle = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await handle.ready;
    const before = asked.length;
    await handle.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 90, rows: 24 }));
    await wait(400);
    // What a fit or a paint asks tmux (a pipe's own upkeep aside).
    const fitWork = asked.slice(before).flatMap((args) => args.filter((a) => ["display-message", "list-panes", "resize-window", "resize-pane", "select-pane", "select-layout", "capture-pane"].includes(a)));
    expect(fitWork).toEqual([]);
    handle.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a fitted viewer whose window another pane's viewer takes is sent nothing until it fits again, then its paint and live bytes", async () => {
  const v = await viewerFixture("fit-taken", (env) => env.tmux.client);
  try {
    const paneB = await secondPane(v);
    const handleA = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await handleA.ready;
    const b = recordingViewer();
    const handleB = v.rt.attachViewer(paneB.id, b.ws, { cols: 100, rows: 30 }, { fit: true });
    await handleB.ready;
    const shown = v.text().length;
    await v.rt.sendKeys(v.pane.id, ["-l", "printf 'while-%s\\n' taken"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    await waitFor(() => v.rt.readScrollback(v.pane.id), (value) => value.includes("while-taken"), { label: "the pane's output" });
    await wait(300);
    expect(v.text().length).toBe(shown);

    await handleA.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 90, rows: 24 }));
    expect(await waitFor(v.text, (value) => value.slice(shown).includes("while-taken"), { timeoutMs: 4000, label: "the paint after fitting again" })).toContain("while-taken");
    await v.rt.sendKeys(v.pane.id, ["-l", "printf 'after-%s\\n' refit"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    expect(await waitFor(v.text, (value) => value.includes("after-refit"), { timeoutMs: 4000, label: "live bytes after fitting again" })).toContain("after-refit");
    handleA.detach();
    handleB.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

// A viewer whose window was taken is one the user may still be typing in
// (the same pane open on a phone and a desktop, side by side): what it types
// takes the window back, so the user sees it, rather than going in unseen.
test("TmuxRuntime: a fitted viewer whose window another pane's viewer took takes it back when it types, and sees what it typed", async () => {
  const v = await viewerFixture("fit-typed-back", (env) => env.tmux.client);
  try {
    const paneB = await secondPane(v);
    const handleA = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await handleA.ready;
    const b = recordingViewer();
    const handleB = v.rt.attachViewer(paneB.id, b.ws, { cols: 100, rows: 30 }, { fit: true });
    await handleB.ready;
    await waitFor(() => windowFit(v.env, paneB.id), (fit) => fit === "1 1 100x30", { label: "B's window" });
    const shown = v.text().length;
    await handleA.handleMessage(JSON.stringify({ type: "input", data: "printf 'typed-%s\\n' back\r" }));
    expect(await waitFor(() => windowFit(v.env, v.pane.id), (fit) => fit === "1 1 90x24", { label: "A's window back" })).toBe("1 1 90x24");
    expect(await waitFor(v.text, (value) => value.slice(shown).includes("typed-back"), { timeoutMs: 4000, label: "what A typed, shown to A" })).toContain("typed-back");
    // B, its window taken in turn, is sent nothing until it types or fits again.
    const shownB = b.text().length;
    await v.rt.sendKeys(paneB.id, ["-l", "printf 'meanwhile-%s\\n' b"]);
    await v.rt.sendKeys(paneB.id, ["Enter"]);
    await waitFor(() => v.rt.readScrollback(paneB.id), (value) => value.includes("meanwhile-b"), { label: "B's pane output" });
    await wait(300);
    expect(b.text().length).toBe(shownB);
    handleA.detach();
    handleB.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: on Auto, a viewer whose window another pane's viewer took gets it back by asking for its fit, never by an input frame (its terminal answers its pane through input)", async () => {
  const v = await viewerFixture("fit-auto-input", (env) => env.tmux.client);
  try {
    const paneB = await secondPane(v);
    const handleA = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true, auto: true });
    await handleA.ready;
    const b = recordingViewer();
    const handleB = v.rt.attachViewer(paneB.id, b.ws, { cols: 100, rows: 30 }, { fit: true });
    await handleB.ready;
    await waitFor(() => windowFit(v.env, paneB.id), (fit) => fit === "1 1 100x30", { label: "B's window" });
    // A cursor-position answer, as xterm sends with no one at it.
    await handleA.handleMessage(JSON.stringify({ type: "input", data: "\u001b[1;1R" }));
    await wait(300);
    expect(await windowFit(v.env, paneB.id)).toBe("1 1 100x30");
    // Used: the browser asks for its fit, ahead of what is typed.
    await handleA.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 90, rows: 24, auto: true }));
    expect(await waitFor(() => windowFit(v.env, v.pane.id), (fit) => fit === "1 1 90x24", { label: "A's window back" })).toBe("1 1 90x24");
    handleA.detach();
    handleB.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

/** Whether the window shows this pane zoomed (`1 1`), and at what size. */
const windowFit = (env: ReturnType<typeof freshRealTmuxProjectEnv>, paneId: string) => tmuxCommand(env.tmux.client, ["display-message", "-p", "-t", paneId, "#{pane_active} #{window_zoomed_flag} #{window_width}x#{window_height}"], { timeout: 1000 }).then((r) => r.stdout.trim());

test("TmuxRuntime: fits asked at once by two panes' viewers go in the order asked, the last one asked holding the window", async () => {
  const v = await viewerFixture("fit-order", (env) => env.tmux.client);
  try {
    const paneB = await secondPane(v);
    const handleA = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await handleA.ready;
    const b = recordingViewer();
    const handleB = v.rt.attachViewer(paneB.id, b.ws, { cols: 90, rows: 24 });
    await handleB.ready;
    // Its attach's last step done, so each fit starts as soon as it is asked.
    await wait(100);
    await Promise.all([
      handleB.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 100, rows: 30 })),
      handleA.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 90, rows: 24 }))
    ]);
    expect(await windowFit(v.env, v.pane.id)).toBe("1 1 90x24");
    handleA.detach();
    handleB.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a viewer whose window another pane's viewer took gets it back, painted, when that one lets it go", async () => {
  const v = await viewerFixture("fit-back", (env) => env.tmux.client);
  try {
    const paneB = await secondPane(v);
    const handleA = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await handleA.ready;
    const b = recordingViewer();
    const handleB = v.rt.attachViewer(paneB.id, b.ws, { cols: 100, rows: 30 }, { fit: true });
    await handleB.ready;
    const shown = v.text().length;
    await handleB.handleMessage(JSON.stringify({ type: "fit", enabled: false }));
    expect(await waitFor(() => windowFit(v.env, v.pane.id), (fit) => fit === "1 1 90x24", { label: "A's window back" })).toBe("1 1 90x24");
    await waitFor(() => v.text().length, (length) => length > shown, { timeoutMs: 4000, label: "A's paint" });
    await v.rt.sendKeys(v.pane.id, ["-l", "printf 'back-%s\\n' live"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    expect(await waitFor(v.text, (value) => value.includes("back-live"), { timeoutMs: 4000, label: "A's live bytes" })).toContain("back-live");
    handleA.detach();
    handleB.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a fitted pane whose screen keeps changing on one row only (a working agent) is painted within about half a second, not after the 1.4 s cap", async () => {
  const v = await viewerFixture("fit-spinner", (env) => env.tmux.client);
  try {
    await respawnPaneWithShellScript(v.env, v.pane.id, `i=0; while :; do printf '\\rworking %d ' "$i"; i=$((i+1)); sleep 0.05; done`);
    await waitFor(() => v.rt.readScrollback(v.pane.id), (value) => value.includes("working"), { label: "the spinner" });
    const started = Date.now();
    const handle = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await waitFor(() => v.text().length, (length) => length > 0, { timeoutMs: 4000, intervalMs: 10, label: "the first paint" });
    expect(Date.now() - started).toBeLessThan(1200);
    handle.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a fitted pane redrawing five rows of one wrapped line is not taken for one row changing: its paint waits for the 1.4 s cap", async () => {
  const v = await viewerFixture("fit-wrapped", (env) => env.tmux.client);
  try {
    // At 90 columns, 450 digits wrap over five rows, all changing each time.
    await respawnPaneWithShellScript(v.env, v.pane.id, `i=0; while :; do i=$((i+1)); printf '\\033[H'; for r in 1 2 3 4 5; do printf '%090d' "$i"; done; sleep 0.05; done`);
    const started = Date.now();
    const handle = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await waitFor(() => v.text().length, (length) => length > 0, { timeoutMs: 4000, intervalMs: 10, label: "the first paint" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1300);
    handle.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a window taken twice in a row goes back to the first holder once both who took it let go", async () => {
  const v = await viewerFixture("fit-back-twice", (env) => env.tmux.client);
  try {
    const paneB = await secondPane(v);
    const paneC = await secondPane(v);
    const handleA = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await handleA.ready;
    const b = recordingViewer();
    const handleB = v.rt.attachViewer(paneB.id, b.ws, { cols: 100, rows: 30 }, { fit: true });
    await handleB.ready;
    const c = recordingViewer();
    const handleC = v.rt.attachViewer(paneC.id, c.ws, { cols: 110, rows: 32 }, { fit: true });
    await handleC.ready;
    await handleB.handleMessage(JSON.stringify({ type: "fit", enabled: false }));
    await handleC.handleMessage(JSON.stringify({ type: "fit", enabled: false }));
    expect(await waitFor(() => windowFit(v.env, v.pane.id), (fit) => fit === "1 1 90x24", { label: "A's window back" })).toBe("1 1 90x24");
    await v.rt.sendKeys(v.pane.id, ["-l", "printf 'first-%s\\n' back"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    expect(await waitFor(v.text, (value) => value.includes("first-back"), { timeoutMs: 4000, label: "A's live bytes" })).toContain("first-back");
    handleA.detach();
    handleB.detach();
    handleC.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a fitted viewer whose window is taken while its first paint is being taken is not sent that paint", async () => {
  // Captures of the first pane are held, and let go one at a time by the test.
  const held: Array<() => void> = [];
  let firstPane = "";
  const v = await viewerFixture("fit-taken-paint", (env) => ({
    socketArgs: env.tmux.client.socketArgs,
    runner: {
      run: async (command: string, args: string[], options?: CommandRunOptions) => {
        if (firstPane && args.includes("capture-pane") && args.includes(firstPane)) await new Promise<void>((resolve) => { held.push(resolve); });
        return nodeCommandRunner.run(command, args, options);
      }
    }
  }));
  try {
    const paneB = await secondPane(v);
    firstPane = v.pane.id;
    const handleA = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    // Three samples alike settle it; the fourth capture is its paint.
    for (let n = 1; n <= 3; n++) {
      await waitFor(() => held.length, (count) => count === 1, { label: `sample ${n}` });
      held.shift()!();
    }
    await waitFor(() => held.length, (count) => count === 1, { label: "the paint's capture" });
    const b = recordingViewer();
    const handleB = v.rt.attachViewer(paneB.id, b.ws, { cols: 100, rows: 30 }, { fit: true });
    await waitFor(() => windowFit(v.env, paneB.id), (fit) => fit === "1 1 100x30", { label: "B's window" });
    firstPane = "";
    held.shift()!();
    await handleA.ready;
    await wait(200);
    expect(v.text()).toBe("");
    handleA.detach();
    handleB.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a fitted viewer whose window is taken before its first paint gets live bytes once it fits again", async () => {
  const v = await viewerFixture("fit-taken-first", (env) => env.tmux.client);
  try {
    const paneB = await secondPane(v);
    const handleA = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await waitFor(() => JSON.stringify(tmuxWindowSize(v.env, v.pane.id)), (size) => size === JSON.stringify({ width: 90, height: 24 }), { label: "A's fitted window" });
    const b = recordingViewer();
    const handleB = v.rt.attachViewer(paneB.id, b.ws, { cols: 100, rows: 30 }, { fit: true });
    await handleB.ready;
    await handleA.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 90, rows: 24 }));
    await wait(1500);
    await v.rt.sendKeys(v.pane.id, ["-l", "printf 'first-%s\\n' live"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    expect(await waitFor(v.text, (value) => value.includes("first-live"), { timeoutMs: 4000, label: "live bytes after fitting again" })).toContain("first-live");
    handleA.detach();
    handleB.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime.attachViewer: what an agent types while a viewer is handed over to live bytes comes back to it", async () => {
  const v = await viewerFixture("agent-handover", slowPipeArm);
  try {
    const handle = await v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 });
    await v.rt.sendKeys(v.pane.id, ["-l", "printf 'agent-%s\\n' marker"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    expect(await waitFor(v.text, (value) => value.includes("agent-marker"), { timeoutMs: 4000, label: "the agent's output" })).toContain("agent-marker");
    handle.detach();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a paste and its Enter from a viewer reach the pane together, whatever an agent sends meanwhile", async () => {
  const sent: string[][] = [];
  let first = true;
  const v = await viewerFixture("input-order", (env) => slowTmux(env, (args) => {
    if (!args.includes("send-keys") || !args.includes("-H") || !first) return null;
    first = false;
    return { before: 300 };
  }, sent));
  try {
    const handle = await v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 });
    await handle.ready;
    const paste = handle.handleMessage(JSON.stringify({ type: "input", data: "echo pasted" }));
    const enter = handle.handleMessage(JSON.stringify({ type: "input", data: "\r" }));
    await wait(50);
    const agent = v.rt.sendKeys(v.pane.id, ["-l", "agent text"]);
    await Promise.all([paste, enter, agent]);
    const order = sent.filter((args) => args.includes("-H") || args.includes("agent text")).map((args) => (args.includes("-H") ? Buffer.from(args.slice(args.indexOf("-H") + 3).join(""), "hex").toString() : "AGENT"));
    expect(order).toEqual(["echo pasted", "\r", "AGENT"]);
    handle.detach();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: output that comes while a refresh's paint is taken is sent after the paint, not lost under it", async () => {
  let slowCapture = false;
  const v = await viewerFixture("refresh-hold", (env) => slowTmux(env, (args) => slowCapture && args.includes("capture-pane") ? { after: 500 } : null));
  try {
    const handle = await v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 });
    await handle.ready;
    await v.rt.sendKeys(v.pane.id, ["-l", "(sleep 0.25; printf 'late-%s\\n' marker) &"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    slowCapture = true;
    await handle.handleMessage(JSON.stringify({ type: "refresh" }));
    slowCapture = false;
    const afterPaint = () => { const all = v.text(); return all.slice(all.lastIndexOf("\x1b[2J\x1b[H")); };
    expect(await waitFor(afterPaint, (value) => value.includes("late-marker"), { timeoutMs: 3000, label: "late output after the paint" })).toContain("late-marker");
    handle.detach();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: what a fitted viewer types while its fit is taken reaches the pane before an agent's later keys", async () => {
  const sent: string[][] = [];
  const v = await viewerFixture("fit-attach-order", (env) => slowTmux(env, (args) => args.includes("display-message") && args.some((a) => a.includes("#{window_layout}")) ? { before: 300 } : null, sent));
  try {
    const handle = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    const typed = handle.handleMessage(JSON.stringify({ type: "input", data: "echo viewer" }));
    await wait(20);
    const agent = v.rt.sendKeys(v.pane.id, ["-l", "agent text"]);
    await Promise.all([typed, agent]);
    const order = sent.filter((args) => args.includes("-H") || args.includes("agent text")).map((args) => (args.includes("-H") ? "VIEWER" : "AGENT"));
    expect(order).toEqual(["VIEWER", "AGENT"]);
    handle.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a fitted viewer whose fit changes twice at once still gets its live bytes after", async () => {
  // Captures are held while asked to, and let go one at a time by the test.
  let holding = false;
  const held: Array<() => void> = [];
  const v = await viewerFixture("fit-twice", (env) => ({
    socketArgs: env.tmux.client.socketArgs,
    runner: {
      run: async (command: string, args: string[], options?: CommandRunOptions) => {
        const answer = await nodeCommandRunner.run(command, args, options);
        if (holding && args.includes("capture-pane")) await new Promise<void>((resolve) => { held.push(resolve); });
        return answer;
      }
    }
  }));
  try {
    const handle = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await handle.ready;
    holding = true;
    // The first fit change's first sample waits on tmux; then a second
    // change, whose first sample waits too.
    void handle.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 100, rows: 30 }));
    await waitFor(() => held.length, (count) => count === 1, { label: "first change's sample" });
    void handle.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 110, rows: 32 }));
    await waitFor(() => held.length, (count) => count === 2, { label: "second change's sample" });
    // tmux answers the older first, the newer a moment after.
    held.shift()!();
    await wait(20);
    holding = false;
    held.shift()!();
    await wait(1500);
    await v.rt.sendKeys(v.pane.id, ["-l", "printf 'after-%s\\n' refit"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    expect(await waitFor(v.text, (value) => value.includes("after-refit"), { timeoutMs: 4000, label: "live bytes after the refits" })).toContain("after-refit");
    handle.detach();
    await waitForFitRestore();
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: what a viewer typed before it went still reaches the pane", async () => {
  const sent: string[][] = [];
  let first = true;
  const v = await viewerFixture("detach-input", (env) => slowTmux(env, (args) => {
    if (!args.includes("send-keys") || !args.includes("-H") || !first) return null;
    first = false;
    return { before: 300 };
  }, sent));
  try {
    const handle = v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 });
    await handle.ready;
    const paste = handle.handleMessage(JSON.stringify({ type: "input", data: "echo gone" }));
    const enter = handle.handleMessage(JSON.stringify({ type: "input", data: "\r" }));
    handle.detach();
    await Promise.all([paste, enter]);
    const typed = sent.filter((args) => args.includes("-H")).map((args) => Buffer.from(args.slice(args.indexOf("-H") + 3).join(""), "hex").toString());
    expect(typed).toEqual(["echo gone", "\r"]);
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime.dispose: a fit still waiting its turn at shutdown takes no lease, and the window is put back", async () => {
  let holding = false;
  const held: Array<() => void> = [];
  const v = await viewerFixture("dispose-fit", (env) => ({
    socketArgs: env.tmux.client.socketArgs,
    runner: {
      run: async (command: string, args: string[], options?: CommandRunOptions) => {
        const answer = await nodeCommandRunner.run(command, args, options);
        if (holding && args.includes("capture-pane")) await new Promise<void>((resolve) => { held.push(resolve); });
        return answer;
      }
    }
  }));
  try {
    const original = tmuxWindowSize(v.env, v.pane.id);
    const handle = v.rt.attachViewer(v.pane.id, v.ws, { cols: 90, rows: 24 }, { fit: true });
    await handle.ready;
    // A refresh holds the pane's turn on tmux; a fit waits behind it.
    holding = true;
    void handle.handleMessage(JSON.stringify({ type: "refresh" }));
    await waitFor(() => held.length, (count) => count > 0, { label: "refresh's capture" });
    void handle.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 110, rows: 32 }));
    await v.rt.dispose();
    holding = false;
    for (const go of held.splice(0)) go();
    await wait(600);
    expect(tmuxWindowSize(v.env, v.pane.id)).toEqual(original);
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime.dispose: within the shutdown's 500 ms every fifo is gone, however slow tmux is to stop the pipes", async () => {
  const v = await viewerFixture("dispose-pipes", (env) => slowTmux(env, (args) => args.includes("pipe-pane") && !args.includes("-O") ? { before: 400 } : null));
  try {
    const second = await v.rt.spawnPane({ workerId: v.env.workers.listAllActive()[0]!.id });
    const wsB: any = { readyState: 1, send: () => {}, close: () => {} };
    const earlierFifos = new Set(fs.readdirSync(os.tmpdir()));
    const handles = [v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 }), v.rt.attachViewer(second.id, wsB, { cols: 80, rows: 24 })];
    await Promise.all(handles.map((handle) => handle.ready));
    // This test's own fifos: another test in this process may have left one.
    const fifos = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`mandate-pipe-${process.pid}-`) && !earlierFifos.has(f));
    expect(fifos().length).toBe(2);
    // As the container waits on the terminal runtime when the server stops.
    await Promise.race([v.rt.dispose(), wait(500)]);
    expect(fifos()).toEqual([]);
  } finally { v.env.cleanup(); }
});

test("TmuxRuntime: a second viewer gets what the pane writes while its first paint is taken", async () => {
  let slowCapture = false;
  const v = await viewerFixture("second-viewer", (env) => slowTmux(env, (args) => slowCapture && args.includes("capture-pane") ? { after: 500 } : null));
  try {
    const first = v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 });
    await first.ready;
    await v.rt.sendKeys(v.pane.id, ["-l", "(sleep 0.25; printf 'second-%s\\n' marker) &"]);
    await v.rt.sendKeys(v.pane.id, ["Enter"]);
    const received: Uint8Array[] = [];
    const wsB: any = { readyState: 1, send: (chunk: Uint8Array | string) => received.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk), close: () => {} };
    slowCapture = true;
    const second = v.rt.attachViewer(v.pane.id, wsB, { cols: 80, rows: 24 });
    await second.ready;
    slowCapture = false;
    const text = () => Buffer.concat(received.map((u) => Buffer.from(u))).toString("utf8");
    expect(await waitFor(text, (value) => value.includes("second-marker"), { timeoutMs: 3000, label: "output during the second viewer's paint" })).toContain("second-marker");
    first.detach();
    second.detach();
  } finally { v.env.cleanup(); }
});

test("TmuxPipeManager.disposeAll: a fifo made while shutdown ran is removed, and so is one whose last viewer had just gone", async () => {
  const env = freshRealTmuxProjectEnv("md-pipe-late-");
  try {
    const projectId = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-pipe-late" });
    seedWorker(env.workers, projectId, { name: "f-late", tmuxWindowName: "f-late" });
    await reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-pipe-late", "f-late", env.dir, env.tmux.client);
    const paneId = (await tmuxCommand(env.tmux.client, ["display-message", "-p", "-t", "alpha-pipe-late:f-late", "#{pane_id}"], { timeout: 1000 })).stdout.trim();
    const pipeDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-pipe-late-dir-"));
    const fifos = () => fs.readdirSync(pipeDir);
    const ws: any = { readyState: 1, send: () => {}, close: () => {} };

    // mkfifo still running when shutdown comes.
    const slowFifo = { run: async (command: string, args: string[], options?: CommandRunOptions) => { await wait(300); return nodeCommandRunner.run(command, args, options); } };
    const late = new TmuxPipeManager({ tmuxClient: env.tmux.client, pipeDir, pipePrefix: "mandate-pipe-late", fifoRunner: slowFifo });
    const ready = late.attachTerminalClient(paneId, ws);
    await wait(50);
    await late.disposeAll();
    await ready.catch(() => {});
    await wait(400);
    expect(fifos()).toEqual([]);

    // The last viewer gone, tmux slow to stop its pipe, shutdown at once.
    const slowStop = slowTmux(env, (args) => args.includes("pipe-pane") && !args.includes("-O") ? { before: 600 } : null);
    const gone = new TmuxPipeManager({ tmuxClient: slowStop, pipeDir, pipePrefix: "mandate-pipe-gone" });
    await gone.attachTerminalClient(paneId, ws);
    expect(fifos().length).toBe(1);
    gone.detachTerminalClient(paneId, ws);
    await wait(20);
    await Promise.race([gone.disposeAll(), wait(500)]);
    expect(fifos()).toEqual([]);
  } finally { env.cleanup(); }
});

test("TmuxRuntime.attachViewer: what a pane writes on its own while its viewer's new pipe is armed is not lost", async () => {
  // The pipe is slow to arm (another pane's pipe work goes first, or tmux is
  // slow): the first paint is taken once the pipe is live, so output in
  // between lands in the viewer's held bytes rather than nowhere.
  const v = await viewerFixture("slow-arm", (env) => slowTmux(env, (args) => args.includes("pipe-pane") && args.includes("-O") ? { before: 800 } : null));
  try {
    await tmuxCommand(v.env.tmux.client, ["send-keys", "-t", v.pane.id, "-l", "(sleep 0.3; printf 'auto-%s\\n' marker) &"], { timeout: 1000 });
    await tmuxCommand(v.env.tmux.client, ["send-keys", "-t", v.pane.id, "Enter"], { timeout: 1000 });
    const handle = v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 });
    await handle.ready;
    expect(await waitFor(v.text, (value) => value.includes("auto-marker"), { timeoutMs: 3000, label: "the pane's own output" })).toContain("auto-marker");
    handle.detach();
  } finally { v.env.cleanup(); }
});

test("TmuxPipeManager.disposeAll: a pipe tmux arms after shutdown removed its fifo leaves no file in its place", async () => {
  const env = freshRealTmuxProjectEnv("md-pipe-arm-late-");
  try {
    const projectId = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-arm-late" });
    seedWorker(env.workers, projectId, { name: "f-arm", tmuxWindowName: "f-arm" });
    await reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
    await tmuxNewWindow("alpha-arm-late", "f-arm", env.dir, env.tmux.client);
    const paneId = (await tmuxCommand(env.tmux.client, ["display-message", "-p", "-t", "alpha-arm-late:f-arm", "#{pane_id}"], { timeout: 1000 })).stdout.trim();
    const pipeDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-pipe-arm-late-dir-"));
    const ws: any = { readyState: 1, send: () => {}, close: () => {} };
    // tmux takes the arm only after shutdown has removed the fifo.
    let mkfifoDone = false;
    const fifoRunner = { run: async (command: string, args: string[], options?: CommandRunOptions) => { const answer = await nodeCommandRunner.run(command, args, options); mkfifoDone = true; return answer; } };
    const slowArm = slowTmux(env, (args) => args.includes("pipe-pane") && args.includes("-O") ? { before: 300 } : null);
    const pipes = new TmuxPipeManager({ tmuxClient: slowArm, pipeDir, pipePrefix: "mandate-pipe-arm-late", fifoRunner });
    const ready = pipes.attachTerminalClient(paneId, ws);
    while (!mkfifoDone) await wait(5);
    await wait(50);
    await pipes.disposeAll();
    await ready.catch(() => {});
    // The shell tmux started has had its time to open (or make) the path.
    await wait(400);
    expect(fs.readdirSync(pipeDir)).toEqual([]);
  } finally { env.cleanup(); }
});

test("TmuxRuntime.attachViewer: a viewer that comes while its pane's pipe is being re-armed paints once bytes flow again", async () => {
  // The pipe ended (tmux stopped it) and its re-arm is slow: a viewer handed
  // over before the re-arm would paint, and what the pane writes between that
  // paint and the re-arm would reach it nowhere.
  let slowArm = false;
  const v = await viewerFixture("rearm-wait", (env) => slowTmux(env, (args) => slowArm && args.includes("pipe-pane") && args.includes("-O") ? { before: 800 } : null));
  try {
    const first = v.rt.attachViewer(v.pane.id, v.ws, { cols: 80, rows: 24 });
    await first.ready;
    slowArm = true;
    expect((await tmuxCommand(v.env.tmux.client, ["pipe-pane", "-t", v.pane.id], { timeout: 1000 })).status).toBe(0);
    await wait(100);
    await tmuxCommand(v.env.tmux.client, ["send-keys", "-t", v.pane.id, "-l", "(sleep 0.3; printf 'gap-%s\\n' marker) &"], { timeout: 1000 });
    await tmuxCommand(v.env.tmux.client, ["send-keys", "-t", v.pane.id, "Enter"], { timeout: 1000 });
    const received: Uint8Array[] = [];
    const wsB: any = { readyState: 1, send: (chunk: Uint8Array | string) => received.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk), close: () => {} };
    const second = v.rt.attachViewer(v.pane.id, wsB, { cols: 80, rows: 24 });
    await second.ready;
    slowArm = false;
    const text = () => Buffer.concat(received.map((u) => Buffer.from(u))).toString("utf8");
    expect(await waitFor(text, (value) => value.includes("gap-marker"), { timeoutMs: 3000, label: "output while the pipe was re-armed" })).toContain("gap-marker");
    first.detach();
    second.detach();
  } finally { v.env.cleanup(); }
});

test("tmuxListSessionsWithWindows: empty server returns []", async () => {
  const tmux = startTestTmuxServer();
  try {
    expect(await tmuxListSessionsWithWindows(tmux.client)).toStrictEqual([]);
  } finally { tmux.cleanup(); }
});

test("tmuxListSessionsWithWindows: returns sessions with their window names", async () => {
  const tmux = startTestTmuxServer();
  try {
    await tmuxNewSession("alpha", "/tmp", tmux.client);
    await tmuxNewSession("beta", "/tmp", tmux.client);
    await tmuxNewWindow("alpha", "win1", "/tmp", tmux.client);
    await tmuxNewWindow("alpha", "win2", "/tmp", tmux.client);
    const result = await tmuxListSessionsWithWindows(tmux.client);
    const byName = new Map(result.map((s) => [s.name, s.windows]));
    expect(byName.has("alpha")).toBeTruthy();
    expect(byName.has("beta")).toBeTruthy();
    // alpha has 3 windows: the default one (named after shell) + win1 + win2.
    // Don't assert exact name of default window — it's whatever the shell is called.
    expect(byName.get("alpha")!.length).toBe(3);
    expect(byName.get("alpha")!.includes("win1")).toBeTruthy();
    expect(byName.get("alpha")!.includes("win2")).toBeTruthy();
    // beta only has its default window
    expect(byName.get("beta")!.length).toBe(1);
  } finally { tmux.cleanup(); }
});

test("TmuxRuntime: on Auto, a window goes back to a terminal attached to it and used after the viewer; the viewer is told the pane's size and painted once it lets go", async () => {
  const name = "auto-give-back";
  const env = freshRealTmuxProjectEnv(`md-${name}-`);
  const session = `alpha-${name}`;
  const projectId = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: session });
  const workerId = seedWorker(env.workers, projectId, { name: `f-${name}`, tmuxWindowName: `f-${name}` });
  await reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
  await tmuxNewWindow(session, `f-${name}`, env.dir, env.tmux.client);
  const rt = new TmuxRuntime({
    tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers, fitRestoreGraceMs: TEST_FIT_RESTORE_GRACE_MS,
    activeTerminalCheckMs: 100
  });
  await rt.init();
  const tmux = (...args: string[]) => spawnSync("tmux", [...env.tmux.client.socketArgs, ...args], { encoding: "utf8", timeout: 1500 }).stdout.trim();
  let desk: ReturnType<typeof spawn> | null = null;
  try {
    const pane = (await rt.listPanes(workerId))[0]!;
    await promptDrawn(env, pane.id);
    // A terminal attached to that window, as a desk's is: a real client, on a
    // pty. Attaching counts as using it (tmux starts its activity there), so
    // it is attached first; tmux keeps whole seconds, so the viewer comes a
    // second on.
    const attach = ["tmux", ...env.tmux.client.socketArgs, "attach", "-t", `${session}:f-${name}`].map((a) => `'${a}'`).join(" ");
    desk = spawn("script", ["-qfec", `stty cols 120 rows 40; exec ${attach}`, "/dev/null"], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, TERM: "xterm-256color" } });
    await waitFor(() => tmux("list-clients", "-F", "#{client_control_mode}"), (out) => out.split("\n").includes("0"), { timeoutMs: 4000, label: "the desk's terminal attached" });
    await wait(1100);
    const { ws, text } = recordingViewer();
    const handle = rt.attachViewer(pane.id, ws, { cols: 50, rows: 16 }, { fit: true, auto: true });
    await waitFor(() => tmux("display-message", "-p", "-t", pane.id, "#{window_width}"), (w) => w === "50", { label: "the window fitted to the viewer" });
    // The desk's terminal not used since: the viewer keeps it.
    await wait(1100);
    expect(givenBackTold(text())).toEqual([]);
    expect(tmux("display-message", "-p", "-t", pane.id, "#{window_width}")).toBe("50");
    desk.stdin!.write("x");
    // Told on its own socket, with the pane's size as given back.
    await waitFor(() => givenBackTold(text()).length, (n) => n === 1, { timeoutMs: 4000, label: "the window given back" });
    // From here (the key's echo may have come while it still held the window).
    const painted = text().length;
    const [cols, rows] = tmux("display-message", "-p", "-t", pane.id, "#{pane_width} #{pane_height}").split(" ").map(Number);
    expect(givenBackTold(text())).toEqual([{ type: "given-back", cols, rows }]);
    // Its own size rule again (resizing the window had set manual).
    expect(tmux("show-options", "-wqv", "-t", pane.id, "window-size")).toBe("");
    // Nothing painted for it until it has taken that size and let go.
    await wait(300);
    expect(text().length).toBe(painted);
    void handle.handleMessage(JSON.stringify({ type: "fit", enabled: false }));
    await waitFor(() => text().length, (n) => n > painted, { timeoutMs: 4000, label: "painted after its let-go" });
    handle.detach();
  } finally {
    // The terminal this test started, by its own handle.
    desk?.kill("SIGKILL");
    await rt.dispose();
    env.cleanup();
  }
}, 20_000);

test("TmuxRuntime: on Auto, a viewer given back while its fit's paint is still settling is sent nothing until it lets go", async () => {
  const name = "auto-give-back-settling";
  const env = freshRealTmuxProjectEnv(`md-${name}-`);
  const session = `alpha-${name}`;
  const projectId = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: session });
  const workerId = seedWorker(env.workers, projectId, { name: `f-${name}`, tmuxWindowName: `f-${name}` });
  await reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
  await tmuxNewWindow(session, `f-${name}`, env.dir, env.tmux.client);
  const rt = new TmuxRuntime({
    tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers, fitRestoreGraceMs: TEST_FIT_RESTORE_GRACE_MS,
    activeTerminalCheckMs: 100
  });
  await rt.init();
  const tmux = (...args: string[]) => spawnSync("tmux", [...env.tmux.client.socketArgs, ...args], { encoding: "utf8", timeout: 1500 }).stdout.trim();
  let desk: ReturnType<typeof spawn> | null = null;
  try {
    const pane = (await rt.listPanes(workerId))[0]!;
    await promptDrawn(env, pane.id);
    // A pane that never stops redrawing: a fit's paint waits out its 1.4 s cap.
    await rt.sendKeys(pane.id, ["-l", "while :; do date +%s%N; sleep 0.05; done"]);
    await rt.sendKeys(pane.id, ["Enter"]);
    const attach = ["tmux", ...env.tmux.client.socketArgs, "attach", "-t", `${session}:f-${name}`].map((a) => `'${a}'`).join(" ");
    desk = spawn("script", ["-qfec", `stty cols 120 rows 40; exec ${attach}`, "/dev/null"], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, TERM: "xterm-256color" } });
    await waitFor(() => tmux("list-clients", "-F", "#{client_control_mode}"), (out) => out.split("\n").includes("0"), { timeoutMs: 4000, label: "the desk's terminal attached" });
    await wait(1100);
    const { ws, text } = recordingViewer();
    const handle = rt.attachViewer(pane.id, ws, { cols: 80, rows: 24 });
    await handle.ready;
    // Fitted (its paint now settling), then the desk's key a second on: given back mid-paint.
    void handle.handleMessage(JSON.stringify({ type: "fit", enabled: true, cols: 50, rows: 16, auto: true }));
    await waitFor(() => tmux("display-message", "-p", "-t", pane.id, "#{window_width}"), (w) => w === "50", { label: "the window fitted" });
    await wait(1050);
    desk.stdin!.write("x");
    await waitFor(() => givenBackTold(text()).length, (n) => n === 1, { timeoutMs: 4000, label: "the window given back" });
    const sent = text().length;
    await wait(500);
    expect(text().length).toBe(sent);
    void handle.handleMessage(JSON.stringify({ type: "fit", enabled: false }));
    await waitFor(() => text().length, (n) => n > sent, { timeoutMs: 4000, label: "its own again after its let-go" });
    handle.detach();
  } finally {
    desk?.kill("SIGKILL");
    await rt.dispose();
    env.cleanup();
  }
}, 20_000);

test("TmuxRuntime: on Auto, a socket come back as a resume for a window a terminal took since is told so first, then painted at the pane's size", async () => {
  const name = "auto-resume";
  const env = freshRealTmuxProjectEnv(`md-${name}-`);
  const session = `alpha-${name}`;
  const projectId = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: session });
  const workerId = seedWorker(env.workers, projectId, { name: `f-${name}`, tmuxWindowName: `f-${name}` });
  await reconcileProject(env.projects.getById(projectId)!, [], tmuxReconcileAdapter(env.tmux.client));
  await tmuxNewWindow(session, `f-${name}`, env.dir, env.tmux.client);
  const rt = new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers, fitRestoreGraceMs: TEST_FIT_RESTORE_GRACE_MS, activeTerminalCheckMs: 100 });
  await rt.init();
  const tmux = (...args: string[]) => spawnSync("tmux", [...env.tmux.client.socketArgs, ...args], { encoding: "utf8", timeout: 1500 }).stdout.trim();
  let desk: ReturnType<typeof spawn> | null = null;
  try {
    const pane = (await rt.listPanes(workerId))[0]!;
    await promptDrawn(env, pane.id);
    const attach = ["tmux", ...env.tmux.client.socketArgs, "attach", "-t", `${session}:f-${name}`].map((a) => `'${a}'`).join(" ");
    desk = spawn("script", ["-qfec", `stty cols 120 rows 40; exec ${attach}`, "/dev/null"], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, TERM: "xterm-256color" } });
    await waitFor(() => tmux("list-clients", "-F", "#{client_control_mode}"), (out) => out.split("\n").includes("0"), { timeoutMs: 4000, label: "the desk's terminal attached" });
    await wait(1100);
    const first = recordingViewer();
    const handle = rt.attachViewer(pane.id, first.ws, { cols: 50, rows: 16 }, { fit: true, auto: true });
    await waitFor(() => tmux("display-message", "-p", "-t", pane.id, "#{window_width}"), (w) => w === "50", { label: "the window fitted" });
    // The socket gone past the grace; the desk's terminal used a second on.
    handle.detach();
    await waitForFitRestore();
    await wait(1050);
    desk.stdin!.write("x");
    await wait(300);
    const back = recordingViewer();
    const again = rt.attachViewer(pane.id, back.ws, { cols: 50, rows: 16 }, { fit: true, auto: true, resume: true });
    await waitFor(() => back.text().length, (n) => n > 40, { timeoutMs: 4000, label: "its first paint" });
    // Told first, ahead of the paint; the window left as the terminal has it.
    expect(back.text().startsWith("\u0000")).toBe(true);
    const [cols, rows] = tmux("display-message", "-p", "-t", pane.id, "#{pane_width} #{pane_height}").split(" ").map(Number);
    expect(givenBackTold(back.text())).toEqual([{ type: "given-back", cols, rows }]);
    expect(tmux("display-message", "-p", "-t", pane.id, "#{window_zoomed_flag}")).toBe("0");
    again.detach();
  } finally {
    desk?.kill("SIGKILL");
    await rt.dispose();
    env.cleanup();
  }
}, 20_000);
