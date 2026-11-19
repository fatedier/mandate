import { expect, test } from "bun:test";
import { buildArchiveProjectTool } from "../src/server/modules/projects/tools/archive-project.js";
import { buildArchiveWorkerTool } from "../src/server/modules/workers/tools/archive-worker.js";
import { buildRestoreWorkerTool } from "../src/server/modules/workers/tools/restore-worker.js";
import { freshProjectEnv, freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { tempDir } from "./helpers/temp.js";
import { stub } from "./helpers/typed.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";

const ctx: ToolContext = {
  threadId: "t1", wakeId: "w1",
  scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }
};

test("archive_project (manager tool): cascade-archives workers", async () => {
  const env = freshProjectEnv("md-ap-");
  const projectId = seedProject(env.projects, {
    name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-arch"
  });
  seedWorker(env.workers, projectId, { name: "f1", tmuxWindowName: "f1" });
  seedWorker(env.workers, projectId, { name: "f2", tmuxWindowName: "f2" });

  const events: any[] = [];
  const tool = buildArchiveProjectTool({
    projectsStore: env.projects,
    workersStore: env.workers,
    tmuxClient: env.tmux.client,
    broadcast: (e) => events.push(e)
  });

  const r = await tool.handler(
    { projectId },
    ctx
  );
  expect(r.ok).toBeTruthy();
  expect(events[0]?.type).toBe("projectArchived");
  // Workers cascaded.
  const remaining = env.workers.listActiveByProject(projectId);
  expect(remaining.length).toBe(0);
  expect(env.projects.getById(projectId)?.archivedAt).toBeTruthy();
});

test("archive_worker (manager tool): archives worker row + broadcasts", async () => {
  const env = freshProjectEnv("md-af-");
  const projectId = seedProject(env.projects, {
    name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-fa"
  });
  const workerId = seedWorker(env.workers, projectId, {
    name: "login", tmuxWindowName: "login"
  });

  const events: any[] = [];
  const archiveHooks: string[] = [];
  const thread = env.agentStore.getOrCreateThread("worker", workerId);
  const tool = buildArchiveWorkerTool({
    workersStore: env.workers,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    tmuxRuntime: new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers }),
    broadcast: (e) => events.push(e),
    beforeWorkerArchive: (id) => {
      archiveHooks.push(id);
      expect(env.workers.getById(id)?.archivedAt).toBeNull();
      expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
    }
  });

  const r = await tool.handler(
    { workerId: workerId },
    ctx
  );
  expect(r.ok).toBeTruthy();
  expect(env.workers.getById(workerId)?.archivedAt).toBeTruthy();
  expect(archiveHooks).toStrictEqual([workerId]);
  expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
  expect(events[0]?.type).toBe("workerArchived");
  expect(events[0]?.data?.id).toBe(workerId);
});

test("archive_worker: soft-archives even when external cleanup fails", async () => {
  const env = freshProjectEnv("md-af-cleanup-");
  const projectId = seedProject(env.projects, {
    name: "alpha",
    workingDir: "/repo",
    isGit: true,
    tmuxSessionName: "alpha-fa-cleanup"
  });
  const workerId = seedWorker(env.workers, projectId, {
    name: "dirty",
    mode: "new-branch-new-worktree",
    branch: "dirty-branch",
    worktreePath: "/repo-dirty",
    tmuxWindowName: "dirty"
  });

  let hookCalled = false;
  const events: any[] = [];
  const tool = buildArchiveWorkerTool({
    workersStore: env.workers,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    gitClient: {
      runner: {
        async run(command, args) {
          if (command === "git" && args.includes("worktree") && args.includes("remove")) {
            return { status: 1, signal: null, stdout: "", stderr: "contains modified or untracked files" };
          }
          if (command === "git" && args.includes("show-ref")) {
            return { status: 0, signal: null, stdout: "refs/heads/dirty-branch\n", stderr: "" };
          }
          if (command === "git" && args.includes("branch") && args.includes("-d")) {
            return { status: 1, signal: null, stdout: "", stderr: "branch is checked out in a worktree" };
          }
          return { status: 1, signal: null, stdout: "", stderr: "" };
        }
      }
    },
    tmuxRuntime: new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers }),
    broadcast: (e) => events.push(e),
    beforeWorkerArchive: () => { hookCalled = true; }
  });

  // The subject here is cleanup after archiving; the user has confirmed.
  const r = await tool.handler(
    { workerId: workerId, confirmedByUser: true },
    ctx
  );
  expect(r.ok).toBeTruthy();
  expect(r.cleanupFailures?.map((failure) => failure.kind)).toEqual(["worktree", "branch"]);
  expect(env.workers.getById(workerId)?.archivedAt).toBeTruthy();
  expect(hookCalled).toBe(true);
  expect(events.some((event) => event.type === "workerArchived")).toBe(true);
  // Each failure says what it was about.
  expect(r.cleanupFailures).toEqual([
    { kind: "worktree", worktreePath: "/repo-dirty", error: expect.stringContaining("contains modified or untracked files") },
    { kind: "branch", branch: "dirty-branch", error: expect.stringContaining("checked out in a worktree") }
  ]);
});

test("archive_worker: refuses a dirty worktree with what it found, and archives once the user confirmed", async () => {
  const env = freshProjectEnv("md-af-check-");
  const worktree = tempDir("md-af-wt-");
  try {
    const projectId = seedProject(env.projects, { name: "alpha", workingDir: "/repo", isGit: true, tmuxSessionName: "alpha-fa-check" });
    const workerId = seedWorker(env.workers, projectId, {
      name: "dirty", mode: "new-branch-new-worktree", branch: "dirty-branch", baseRef: "main",
      worktreePath: worktree, tmuxWindowName: "dirty"
    });
    const tool = buildArchiveWorkerTool({
      workersStore: env.workers,
      projectsStore: env.projects,
      agentStore: env.agentStore,
      tmuxClient: env.tmux.client,
      gitClient: {
        runner: {
          async run(command, args) {
            if (command === "git" && args.includes("status") && args.includes("--porcelain")) {
              return { status: 0, signal: null, stdout: " M src/a.ts\n", stderr: "" };
            }
            if (command === "git" && args.includes("rev-list")) {
              return { status: 0, signal: null, stdout: "0\n", stderr: "" };
            }
            return { status: 1, signal: null, stdout: "", stderr: "" };
          }
        }
      },
      tmuxRuntime: new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers }),
      broadcast: () => {}
    });

    const refused = await tool.handler({ workerId: workerId }, ctx);
    expect(refused.error).toBe("1 uncommitted file in the worktree.");
    expect(refused.check).toMatchObject({ dirtyFiles: 1, unmergedCommits: 0, branch: "dirty-branch", baseRef: "main" });
    expect(env.workers.getById(workerId)?.archivedAt).toBe(null);

    const archived = await tool.handler({ workerId: workerId, confirmedByUser: true, removeWorktree: false, deleteBranch: false }, ctx);
    expect(archived.ok).toBe(true);
    expect(env.workers.getById(workerId)?.archivedAt).toBeTruthy();
  } finally { env.cleanup(); }
});

test("archive_worker: uncommitted files in a borrowed checkout do not block archiving", async () => {
  // existing-branch-existing-worktree: the checkout is the user's, and archiving
  // leaves it where it is — nothing in it is lost.
  const env = freshProjectEnv("md-af-borrowed-");
  const worktree = tempDir("md-af-borrowed-wt-");
  try {
    const projectId = seedProject(env.projects, { name: "alpha", workingDir: "/repo", isGit: true, tmuxSessionName: "alpha-fa-borrowed" });
    const workerId = seedWorker(env.workers, projectId, {
      name: "borrowed", mode: "existing-branch-existing-worktree", branch: "their-branch", baseRef: "main",
      worktreePath: worktree, tmuxWindowName: "borrowed"
    });
    const tool = buildArchiveWorkerTool({
      workersStore: env.workers,
      projectsStore: env.projects,
      agentStore: env.agentStore,
      tmuxClient: env.tmux.client,
      gitClient: {
        runner: {
          async run(command, args) {
            if (command === "git" && args.includes("status") && args.includes("--porcelain")) {
              return { status: 0, signal: null, stdout: " M src/a.ts\n", stderr: "" };
            }
            if (command === "git" && args.includes("rev-list")) {
              return { status: 0, signal: null, stdout: "0\n", stderr: "" };
            }
            return { status: 1, signal: null, stdout: "", stderr: "" };
          }
        }
      },
      tmuxRuntime: new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers }),
      broadcast: () => {}
    });

    const result = await tool.handler({ workerId: workerId }, ctx);
    expect({ ok: result.ok, error: result.error }).toEqual({ ok: true, error: undefined });
    expect(env.workers.getById(workerId)?.archivedAt).toBeTruthy();
  } finally { env.cleanup(); }
});

test("restore_worker: restores archived worker and unarchives main thread", async () => {
  const env = freshProjectEnv("md-rf-");
  const projectId = seedProject(env.projects, {
    name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-restore"
  });
  const workerId = seedWorker(env.workers, projectId, {
    name: "restore me", tmuxWindowName: "restore_me"
  });
  const thread = env.agentStore.getOrCreateThread("worker", workerId);
  env.workers.archive(workerId);
  env.agentStore.archiveThread(thread.id);

  const events: any[] = [];
  const tool = buildRestoreWorkerTool({
    workersStore: env.workers,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    tmuxRuntime: stub<TmuxRuntime>(),
    broadcast: (e) => events.push(e)
  });

  const r = await tool.handler(
    { workerId: workerId },
    ctx
  );
  expect(r.ok).toBeTruthy();
  expect(env.workers.getById(workerId)?.archivedAt).toBeNull();
  expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
  expect(events[0]?.type).toBe("workerRestored");
});

test("restore_worker: reports branch conflicts before recreating worktree", async () => {
  const env = freshProjectEnv("md-rf-conflict-");
  const projectId = seedProject(env.projects, {
    name: "alpha",
    workingDir: "/repo",
    isGit: true,
    tmuxSessionName: "alpha-restore-conflict"
  });
  const workerId = seedWorker(env.workers, projectId, {
    name: "restore conflict",
    mode: "new-branch-new-worktree",
    branch: "feature/conflict",
    baseRef: "main",
    worktreePath: "/repo-conflict",
    tmuxWindowName: "restore_conflict"
  });
  env.workers.archive(workerId);

  const tool = buildRestoreWorkerTool({
    workersStore: env.workers,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    gitClient: {
      runner: {
        async run(command, args) {
          if (command === "git" && args.includes("show-ref")) {
            return { status: 0, signal: null, stdout: "refs/heads/feature/conflict\n", stderr: "" };
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        }
      }
    },
    tmuxRuntime: stub<TmuxRuntime>(),
    broadcast: () => {}
  });

  const r = await tool.handler(
    { workerId: workerId },
    ctx
  );
  expect(r.ok).toBeUndefined();
  expect(r.error).toBe("branch 'feature/conflict' already exists");
  expect(env.workers.getById(workerId)?.archivedAt).toBeTruthy();
});

test("archive_worker: returns error for missing worker", async () => {
  const env = freshStoresEnv("md-af-");
  // No tmux needed since we never reach the worktree path.
  const tool = buildArchiveWorkerTool({
    workersStore: env.workers,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: stub<TmuxClient>(),
    tmuxRuntime: stub<TmuxRuntime>(),
    broadcast: () => {}
  });
  const r = await tool.handler(
    { workerId: "nope" },
    ctx
  );
  expect(String(r.error)).toMatch(/not found/i);
});
