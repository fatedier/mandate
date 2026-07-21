import { expect, test } from "bun:test";
import { buildArchiveProjectTool } from "../src/server/modules/projects/tools/archive-project.js";
import { buildArchiveFeatureTool } from "../src/server/modules/features/tools/archive-feature.js";
import { buildRestoreFeatureTool } from "../src/server/modules/features/tools/restore-feature.js";
import { freshProjectEnv, freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("archive_project (manager tool): cascade-archives features", async () => {
  const env = freshProjectEnv("md-ap-");
  try {
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
      { threadId: "t1", wakeId: "w1" }
    );
    expect(r.ok).toBeTruthy();
    expect(events[0]?.type).toBe("projectArchived");
    // Features cascaded.
    const remaining = env.features.listActiveByProject(projectId);
    expect(remaining.length).toBe(0);
    expect(env.projects.getById(projectId)?.archivedAt).toBeTruthy();
  } finally { env.cleanup(); }
});

test("archive_feature (manager tool): archives feature row + broadcasts", async () => {
  const env = freshProjectEnv("md-af-");
  try {
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
      broadcast: (e) => events.push(e),
      beforeFeatureArchive: (id) => {
        archiveHooks.push(id);
        expect(env.features.getById(id)?.archivedAt).toBeNull();
        expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
      }
    });

    const r = await tool.handler(
      { featureId },
      { threadId: "t1", wakeId: "w1" }
    );
    expect(r.ok).toBeTruthy();
    expect(env.features.getById(featureId)?.archivedAt).toBeTruthy();
    expect(archiveHooks).toEqual([featureId]);
    expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
    expect(events[0]?.type).toBe("featureArchived");
    expect((events[0]?.data as any)?.id).toBe(featureId);
  } finally { env.cleanup(); }
});

test("archive_feature: soft-archives even when external cleanup fails", async () => {
  const env = freshProjectEnv("md-af-cleanup-");
  try {
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
      broadcast: (e) => events.push(e),
      beforeFeatureArchive: () => { hookCalled = true; }
    });

    const r = await tool.handler(
      { featureId },
      { threadId: "t1", wakeId: "w1" }
    );
    expect(r.ok).toBeTruthy();
    expect(r.cleanupFailures?.map((failure) => failure.kind)).toEqual(["worktree", "branch"]);
    expect(env.features.getById(featureId)?.archivedAt).toBeTruthy();
    expect(hookCalled).toBe(true);
    expect(events.some((event) => event.type === "featureArchived")).toBe(true);
    expect(events.some((event) => event.type === "featureWorktreeCleanupFailed")).toBe(true);
    expect(events.some((event) => event.type === "featureBranchCleanupFailed")).toBe(true);
  } finally { env.cleanup(); }
});

test("restore_feature: restores archived feature and unarchives main thread", async () => {
  const env = freshProjectEnv("md-rf-");
  try {
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
      paneRuntimes: null as any,
      broadcast: (e) => events.push(e)
    });

    const r = await tool.handler(
      { featureId },
      { threadId: "t1", wakeId: "w1" }
    );
    expect(r.ok).toBeTruthy();
    expect(env.features.getById(featureId)?.archivedAt).toBeNull();
    expect(env.agentStore.getThreadById(thread.id)?.archivedAt).toBeNull();
    expect(events[0]?.type).toBe("featureRestored");
  } finally { env.cleanup(); }
});

test("restore_feature: reports branch conflicts before recreating worktree", async () => {
  const env = freshProjectEnv("md-rf-conflict-");
  try {
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
      paneRuntimes: null as any,
      broadcast: () => {}
    });

    const r = await tool.handler(
      { featureId },
      { threadId: "t1", wakeId: "w1" }
    );
    expect(r.ok).toBeUndefined();
    expect(r.error).toBe("branch 'feature/conflict' already exists");
    expect(env.features.getById(featureId)?.archivedAt).toBeTruthy();
  } finally { env.cleanup(); }
});

test("archive_feature: returns error for missing feature", async () => {
  const env = freshStoresEnv("md-af-");
  try {
    // No tmux needed since we never reach the worktree path.
    const tool = buildArchiveFeatureTool({
      featuresStore: env.features,
      projectsStore: env.projects,
      agentStore: env.agentStore,
      tmuxClient: null as any,
      broadcast: () => {}
    });
    const r = await tool.handler(
      { featureId: "nope" },
      { threadId: "t1", wakeId: "w1" }
    );
    expect(String(r.error)).toMatch(/not found/i);
  } finally { env.cleanup(); }
});
