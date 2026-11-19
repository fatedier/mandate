import { expect, test } from "bun:test";
import { WorkerWindowStore } from "../src/server/modules/workers/worker-window-store.js";
import { workerWindowKey } from "../src/server/modules/agent/tools/pane-monitor-target.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";

/**
 * Two producers build the same tmux window key from independent code
 * paths: WorkerWindowStore.listActiveWindowKeys() reads it back out of SQL
 * columns; pane-monitor-target.ts's workerWindowKey() builds it from in-memory
 * ProjectRow/WorkerRow fields. A regression in either producer's template —
 * e.g. one of them growing a host segment back — must fail this test.
 *
 * Comparing each side to a hardcoded literal (the earlier version of this
 * test) only pins one producer at a time: if both regressed to the same
 * three-segment shape together, or if only the untested side regressed, the
 * literal-based tests would stay green. Deriving both sides from the same
 * seeded row and comparing them to each other is the only arrangement that
 * actually enforces "these two agree."
 */
test("WorkerWindowStore and pane-monitor-target.ts's workerWindowKey agree on the key shape", () => {
  const env = freshStoresEnv("md-window-key-");
  const projectId = seedProject(env.projects, { tmuxSessionName: "alpha" });
  const workerId = seedWorker(env.workers, projectId, { tmuxWindowName: "login" });
  const project = env.projects.getById(projectId)!;
  const worker = env.workers.getById(workerId)!;

  const store = new WorkerWindowStore(env.store.db);
  const storeKeys = [...store.listActiveWindowKeys()];

  expect(storeKeys).toEqual([workerWindowKey(project, worker)]);

  // The equality above would still hold if both producers regressed to the
  // same wrong shape together (e.g. both grew a host segment back). Pin the
  // shape itself so that failure mode is caught too.
  expect(storeKeys[0]!.split(":")).toHaveLength(2);
});
