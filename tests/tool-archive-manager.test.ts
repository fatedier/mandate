import { expect, test } from "bun:test";
import { buildArchiveProjectTool } from "../src/server/modules/projects/tools/archive-project.js";
import { buildArchiveFeatureTool } from "../src/server/modules/features/tools/archive-feature.js";
import { buildRestoreFeatureTool } from "../src/server/modules/features/tools/restore-feature.js";
import { freshProjectEnv, freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { buildPaneRuntimes, type PaneRuntimeRegistry } from "../src/server/runtime/pane-runtime-registry.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { tempDir } from "./helpers/temp.js";
import { stub } from "./helpers/typed.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";

const ctx: ToolContext = {
  threadId: "t1", wakeId: "w1",
  scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }
};

test("archive_project (manager tool): cascade-archives features", async () => {
  const env = freshProjectEnv("md-ap-");
  const projectId = seedProject(env.projects, {
    name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-arch"
  });
  seedFeature(env.features, projectId, { name: "f1", tmuxWindowName: "f1" });
  seedFeature(env.features, projectId, { name: "f2", tmuxWindowName: "f2" });

  const events: any[] = [];
  const tool = buildArchiveProjectTool({
    projectsStore: env.projects,
    featuresStore: env.features,
    tmuxClient: env.tmux.client,
    broadcast: (e) => events.push(e)
  });

  const r = await tool.handler(
    { projectId },
    ctx
  );
  expect(r.ok).toBeTruthy();
  expect(events[0]?.type).toBe("projectArchived");
  // Features cascaded.
  const remaining = env.features.listActiveByProject(projectId);
  expect(remaining.length).toBe(0);
  expect(env.projects.getById(projectId)?.archivedAt).toBeTruthy();
});

test("archive_feature (manager tool): archives feature row + broadcasts", async () => {
  const env = freshProjectEnv("md-af-");
  const projectId = seedProject(env.projects, {
    name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-fa"
  });
  const featureId = seedFeature(env.features, projectId, {
    name: "login", tmuxWindowName: "login"
  });

  const events: any[] = [];
  const archiveHooks: string[] = [];
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  const tool = buildArchiveFeatureTool({
    featuresStore: env.features,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    paneRuntimes: buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features }),
    broadcast: (e) => events.push(e),
    beforeFeatureArchive: (id) => {
      archiveHooks.push(id);
      expect(env.features.getById(id)?.archivedAt).toBeNull();
      expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
    }
  });

  const r = await tool.handler(
    { featureId },
    ctx
  );
  expect(r.ok).toBeTruthy();
  expect(env.features.getById(featureId)?.archivedAt).toBeTruthy();
  expect(archiveHooks).toStrictEqual([featureId]);
  expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
  expect(events[0]?.type).toBe("featureArchived");
  expect(events[0]?.data?.id).toBe(featureId);
});

test("archive_feature: soft-archives even when external cleanup fails", async () => {
  const env = freshProjectEnv("md-af-cleanup-");
  const projectId = seedProject(env.projects, {
    name: "alpha",
    workingDir: "/repo",
    isGit: true,
    tmuxSessionName: "alpha-fa-cleanup"
  });
  const featureId = seedFeature(env.features, projectId, {
    name: "dirty",
    mode: "new-branch-new-worktree",
    branch: "dirty-branch",
    worktreePath: "/repo-dirty",
    tmuxWindowName: "dirty"
  });

  let hookCalled = false;
  const events: any[] = [];
  const tool = buildArchiveFeatureTool({
    featuresStore: env.features,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    gitClient: {
      runner: {
        run(command, args) {
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
    paneRuntimes: buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features }),
    broadcast: (e) => events.push(e),
    beforeFeatureArchive: () => { hookCalled = true; }
  });

  // The subject here is cleanup after archiving; the user has confirmed.
  const r = await tool.handler(
    { featureId, confirmedByUser: true },
    ctx
  );
  expect(r.ok).toBeTruthy();
  expect(r.cleanupFailures?.map((failure) => failure.kind)).toEqual(["worktree", "branch"]);
  expect(env.features.getById(featureId)?.archivedAt).toBeTruthy();
  expect(hookCalled).toBe(true);
  expect(events.some((event) => event.type === "featureArchived")).toBe(true);
  // Each failure is announced with what it was about.
  expect(events.find((event) => event.type === "featureWorktreeCleanupFailed")?.data)
    .toEqual({ id: featureId, worktreePath: "/repo-dirty", error: expect.stringContaining("contains modified or untracked files") });
  expect(events.find((event) => event.type === "featureBranchCleanupFailed")?.data)
    .toEqual({ id: featureId, branch: "dirty-branch", error: expect.stringContaining("checked out in a worktree") });
});

test("archive_feature: refuses a dirty worktree with what it found, and archives once the user confirmed", async () => {
  const env = freshProjectEnv("md-af-check-");
  const worktree = tempDir("md-af-wt-");
  try {
    const projectId = seedProject(env.projects, { name: "alpha", workingDir: "/repo", isGit: true, tmuxSessionName: "alpha-fa-check" });
    const featureId = seedFeature(env.features, projectId, {
      name: "dirty", mode: "new-branch-new-worktree", branch: "dirty-branch", baseRef: "main",
      worktreePath: worktree, tmuxWindowName: "dirty"
    });
    const tool = buildArchiveFeatureTool({
      featuresStore: env.features,
      projectsStore: env.projects,
      agentStore: env.agentStore,
      tmuxClient: env.tmux.client,
      gitClient: {
        runner: {
          run(command, args) {
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
      paneRuntimes: buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features }),
      broadcast: () => {}
    });

    const refused = await tool.handler({ featureId }, ctx);
    expect(refused.error).toBe("1 uncommitted file in the worktree.");
    expect(refused.check).toMatchObject({ dirtyFiles: 1, unmergedCommits: 0, branch: "dirty-branch", baseRef: "main" });
    expect(env.features.getById(featureId)?.archivedAt).toBe(null);

    const archived = await tool.handler({ featureId, confirmedByUser: true, removeWorktree: false, deleteBranch: false }, ctx);
    expect(archived.ok).toBe(true);
    expect(env.features.getById(featureId)?.archivedAt).toBeTruthy();
  } finally { env.cleanup(); }
});

test("archive_feature: uncommitted files in a borrowed checkout do not block archiving", async () => {
  // existing-branch-existing-worktree: the checkout is the user's, and archiving
  // leaves it where it is — nothing in it is lost.
  const env = freshProjectEnv("md-af-borrowed-");
  const worktree = tempDir("md-af-borrowed-wt-");
  try {
    const projectId = seedProject(env.projects, { name: "alpha", workingDir: "/repo", isGit: true, tmuxSessionName: "alpha-fa-borrowed" });
    const featureId = seedFeature(env.features, projectId, {
      name: "borrowed", mode: "existing-branch-existing-worktree", branch: "their-branch", baseRef: "main",
      worktreePath: worktree, tmuxWindowName: "borrowed"
    });
    const tool = buildArchiveFeatureTool({
      featuresStore: env.features,
      projectsStore: env.projects,
      agentStore: env.agentStore,
      tmuxClient: env.tmux.client,
      gitClient: {
        runner: {
          run(command, args) {
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
      paneRuntimes: buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features }),
      broadcast: () => {}
    });

    const result = await tool.handler({ featureId }, ctx);
    expect({ ok: result.ok, error: result.error }).toEqual({ ok: true, error: undefined });
    expect(env.features.getById(featureId)?.archivedAt).toBeTruthy();
  } finally { env.cleanup(); }
});

test("restore_feature: restores archived feature and unarchives main thread", async () => {
  const env = freshProjectEnv("md-rf-");
  const projectId = seedProject(env.projects, {
    name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-restore"
  });
  const featureId = seedFeature(env.features, projectId, {
    name: "restore me", tmuxWindowName: "restore_me"
  });
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  env.features.archive(featureId);
  env.agentStore.archiveThread(thread.id);

  const events: any[] = [];
  const tool = buildRestoreFeatureTool({
    featuresStore: env.features,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    paneRuntimes: stub<PaneRuntimeRegistry>(),
    broadcast: (e) => events.push(e)
  });

  const r = await tool.handler(
    { featureId },
    ctx
  );
  expect(r.ok).toBeTruthy();
  expect(env.features.getById(featureId)?.archivedAt).toBeNull();
  expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
  expect(events[0]?.type).toBe("featureRestored");
});

test("restore_feature: reports branch conflicts before recreating worktree", async () => {
  const env = freshProjectEnv("md-rf-conflict-");
  const projectId = seedProject(env.projects, {
    name: "alpha",
    workingDir: "/repo",
    isGit: true,
    tmuxSessionName: "alpha-restore-conflict"
  });
  const featureId = seedFeature(env.features, projectId, {
    name: "restore conflict",
    mode: "new-branch-new-worktree",
    branch: "feature/conflict",
    baseRef: "main",
    worktreePath: "/repo-conflict",
    tmuxWindowName: "restore_conflict"
  });
  env.features.archive(featureId);

  const tool = buildRestoreFeatureTool({
    featuresStore: env.features,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    gitClient: {
      runner: {
        run(command, args) {
          if (command === "git" && args.includes("show-ref")) {
            return { status: 0, signal: null, stdout: "refs/heads/feature/conflict\n", stderr: "" };
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        }
      }
    },
    paneRuntimes: stub<PaneRuntimeRegistry>(),
    broadcast: () => {}
  });

  const r = await tool.handler(
    { featureId },
    ctx
  );
  expect(r.ok).toBeUndefined();
  expect(r.error).toBe("branch 'feature/conflict' already exists");
  expect(env.features.getById(featureId)?.archivedAt).toBeTruthy();
});

test("archive_feature: returns error for missing feature", async () => {
  const env = freshStoresEnv("md-af-");
  // No tmux needed since we never reach the worktree path.
  const tool = buildArchiveFeatureTool({
    featuresStore: env.features,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: stub<TmuxClient>(),
    paneRuntimes: stub<PaneRuntimeRegistry>(),
    broadcast: () => {}
  });
  const r = await tool.handler(
    { featureId: "nope" },
    ctx
  );
  expect(String(r.error)).toMatch(/not found/i);
});
