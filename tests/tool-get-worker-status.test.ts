import { expect, test } from "bun:test";
import { buildGetWorkerStatusTool } from "../src/server/modules/workers/tools/get-worker-status.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import type { TmuxSnapshot } from "../src/server/platform/tmux/tmux-types.js";

// The window-key agreement between pane-monitor-target.ts and worker-window-store.ts
// is pinned in tests/window-key-contract.test.ts, not here — that test needs
// both stores and a DB-backed WorkerWindowStore, which get_worker_status
// doesn't touch.

function seedAlphaLogin(env: ReturnType<typeof freshStoresEnv>) {
  const pId = seedProject(env.projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
  const workerId = seedWorker(env.workers, pId, { name: "login", tmuxWindowName: "login" });
  return { pId, workerId };
}

test("get_worker_status: returns shape with worker + panes from snapshot", async () => {
  const env = freshStoresEnv("md-gfs-");
  const { workerId } = seedAlphaLogin(env);

  const fakeSnapshot = {
    sessions: [{
      sessionName: "alpha",
      windows: [{
        windowName: "login",
        aggregate: { status: "working", title: "Implementing login" },
        panes: [
          { paneId: "%1", analysis: { status: "working", summary: "running tests" }, currentCommand: "pnpm", changedAt: "2026-05-03T10:00:00Z" }
        ]
      }]
    }]
  };

  const tool = buildGetWorkerStatusTool({
    workersStore: env.workers,
    projectsStore: env.projects,
    getSnapshot: () => fakeSnapshot as unknown as TmuxSnapshot
  });
  const r = await tool.handler({ workerId: workerId }, toolContext());
  expect(r.worker).toBeTruthy();
  expect(r.worker?.name).toBe("login");
  expect(r.aggregateStatus).toBe("working");
  expect(r.aggregateTitle).toBe("Implementing login");
  expect(r.panes?.length).toBe(1);
  expect(r.panes?.[0]!.status).toBe("working");
  expect(r.panes?.[0]!.command).toBe("pnpm");
  expect(r.panes?.[0]!.summary).toBe("running tests");
  expect(r.panes?.[0]!.changedAt).toBe("2026-05-03T10:00:00Z");
});

test("get_worker_status: returns error for missing worker", async () => {
  const env = freshStoresEnv("md-gfs-");
  const tool = buildGetWorkerStatusTool({
    workersStore: env.workers, projectsStore: env.projects,
    getSnapshot: () => ({} as unknown as TmuxSnapshot)
  });
  const r = await tool.handler({ workerId: "nope" }, toolContext());
  expect(String(r.error)).toMatch(/not found/i);
});

test("get_worker_status: handles null snapshot (pre-first-poll)", async () => {
  const env = freshStoresEnv("md-gfs-");
  const { workerId } = seedAlphaLogin(env);
  const tool = buildGetWorkerStatusTool({
    workersStore: env.workers, projectsStore: env.projects,
    getSnapshot: () => null
  });
  const r = await tool.handler({ workerId: workerId }, toolContext());
  expect(r.worker).toBeTruthy();
  expect(r.aggregateStatus).toBe("unknown");
  expect(r.panes?.length).toBe(0);
});

test("get_worker_status: a session without the worker's window reports nothing of another window", async () => {
  const env = freshStoresEnv("md-gfs-");
  const { workerId } = seedAlphaLogin(env);
  const other = {
    sessions: [{
      sessionName: "alpha",
      windows: [{
        windowName: "signup",
        aggregate: { status: "working", title: "Someone else's work" },
        panes: [{ paneId: "%9", analysis: { status: "working", summary: "x" }, currentCommand: "vim", changedAt: "2026-05-03T10:00:00Z" }]
      }]
    }]
  };
  const tool = buildGetWorkerStatusTool({
    workersStore: env.workers, projectsStore: env.projects,
    getSnapshot: () => other as unknown as TmuxSnapshot
  });
  const r = await tool.handler({ workerId: workerId }, toolContext());
  expect(r.worker).toBeTruthy();
  expect(r.aggregateStatus).toBe("unknown");
  expect(r.panes?.length).toBe(0);
});

test("get_worker_status says what runs in the background for the worker, and the description says so", async () => {
  const env = freshStoresEnv("md-gfs-tasks-");
  const { workerId } = seedAlphaLogin(env);
  const worker = env.agentStore.getOrCreateThread("worker", workerId);
  const item = { taskId: "task_cmd", kind: "command" as const, title: "Run the e2e suite", status: "running" as const, runningFor: "2m 05s", command: "make e2e", outputPath: "/out/task_cmd.log", outputBytes: 2048, outputLines: 40 };
  const asked: string[] = [];
  const tool = buildGetWorkerStatusTool({
    workersStore: env.workers, projectsStore: env.projects, agentStore: env.agentStore,
    getSnapshot: () => ({ sessions: [] } as unknown as TmuxSnapshot),
    tasksOfThread: (threadId) => { asked.push(threadId); return [item]; }
  });
  expect(tool.description).toBe("Get the current analyzer status, active panes and running background tasks for a worker.");
  expect((await tool.handler({ workerId: workerId }, toolContext())).backgroundTasks).toEqual([item]);
  expect(asked).toStrictEqual([worker.id]);
  // A worker whose worker never ran has none.
  const other = seedWorker(env.workers, env.workers.getById(workerId)!.projectId, { name: "logout", tmuxWindowName: "logout" });
  expect((await tool.handler({ workerId: other }, toolContext())).backgroundTasks).toEqual([]);
});
