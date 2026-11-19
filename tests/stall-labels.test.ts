import { expect, spyOn, test } from "bun:test";
import { stallWatch } from "../src/server/platform/diagnostics/stall-watch.js";
import { capturePanePreview } from "../src/server/platform/tmux/tmux-state.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";
import { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { BroadcastCenter } from "../src/server/runtime/broadcast-center.js";
import { TmuxPoller } from "../src/server/runtime/tmux-poller.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { createBackgroundCommandService } from "../src/server/runtime/background-commands.js";
import { onCleanup } from "./helpers/cleanup.js";
import { freshStoresEnv, withTempDataDir } from "./helpers/fixtures.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { tempDir } from "./helpers/temp.js";

// The stall log names the work that held the server's thread. Work that ran
// unnamed showed as "nothing recorded ran then": the tmux poll's handling of
// what it captured, and a running command's output. These name it.

/** The labels `fn` timed through the stall watch, synchronous or under way. */
async function labelsOf(fn: () => Promise<unknown>): Promise<Set<string>> {
  const run = spyOn(stallWatch, "run");
  const watched = spyOn(stallWatch, "watched");
  try {
    await fn();
    return new Set([...run.mock.calls, ...watched.mock.calls].map((call) => call[0]));
  } finally {
    run.mockRestore();
    watched.mockRestore();
  }
}

const quietTmux: TmuxClient = { socketArgs: [], runner: { run: async () => ({ status: 0, signal: null, stdout: "", stderr: "" }) } };

test("a pane's captured text is named as it is cleaned", async () => {
  const client: TmuxClient = { socketArgs: [], runner: { run: async () => ({ status: 0, signal: null, stdout: "\x1b[32mready\x1b[0m\n", stderr: "" }) } };
  const labels = await labelsOf(() => capturePanePreview("%1", 10, client));
  expect(labels).toContain("tmux pane text");
});

test("a poll's snapshot and the project state after it are named", async () => {
  const sse = new AgentSseEmitter();
  const broadcaster = new BroadcastCenter({
    sse, tmuxClient: quietTmux, projectsStore: { listActive: () => [] }, workersStore: {}
  } as unknown as ConstructorParameters<typeof BroadcastCenter>[0]);
  const poller = new TmuxPoller({
    sse, broadcaster, tmuxClient: quietTmux, analyzer: new Analyzer(), captureLines: 0,
    store: { listWorkerWindowKeys: () => new Set() }
  } as unknown as ConstructorParameters<typeof TmuxPoller>[0]);
  const labels = await labelsOf(() => poller.poll());
  expect(poller.getLastError()).toBeNull();
  expect(labels).toContain("tmux poll snapshot");
  expect(labels).toContain("tmux projects state");
});

test("a running command's output, and the reading of its tail, are named", async () => {
  const env = freshStoresEnv("md-stall-labels-");
  const data = withTempDataDir();
  onCleanup(() => { data.restore(); env.cleanup(); });
  const tasks = new BackgroundTaskStore(env.store.db);
  const service = createBackgroundCommandService({
    db: env.store.db, tasks, agentStore: env.agentStore, runner: testShellRunner(tempDir("stall-labels-home-")),
    dataDir: data.dataDir, sse: { emit: () => {} }, wake: () => "wake_x"
  });
  onCleanup(() => service.dispose());
  const parent = env.agentStore.createManagerThread("Build");
  const labels = await labelsOf(async () => {
    const task = await service.start({ parentThreadId: parent.id, command: "printf 'one\\ntwo\\n'", title: "Two lines", cwd: "/tmp", owner: { kind: "global" } });
    for (let i = 0; i < 300 && tasks.get(task.id)!.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(tasks.get(task.id)!.status).toBe("finished");
  });
  expect(labels).toContain("command output");
  expect(labels).toContain("command output tail");
});
