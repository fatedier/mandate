import { expect, test } from "bun:test";
import { reconcileProject } from "../src/server/modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../src/server/modules/projects/tmux-reconcile-adapter.js";
import { buildCreateFeatureTool } from "../src/server/modules/features/tools/create-feature.js";
import { buildFeatureLifecycleToolPacks } from "../src/server/modules/features/feature-tool-packs.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import type { GitClient } from "../src/server/platform/git/git.js";
import { stub } from "./helpers/typed.js";
import { buildPaneRuntimes } from "../src/server/runtime/pane-runtime-registry.js";
import { freshProjectEnv, seedProject } from "./helpers/fixtures.js";

function buildRegistry(env: ReturnType<typeof freshProjectEnv>) {
  return buildPaneRuntimes({
    tmuxClient: env.tmux.client,
    projectsStore: env.projects,
    featuresStore: env.features
  });
}

test("create_feature (manager tool): creates feature row + tmux window", async () => {
  const env = freshProjectEnv("md-cf-");
  const projectId = seedProject(env.projects, {
    name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-test"
  });
  const project = env.projects.getById(projectId)!;
  reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));

  const events: any[] = [];
  const tool = buildCreateFeatureTool({
    featuresStore: env.features,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    paneRuntimes: buildRegistry(env),
    broadcast: (e) => events.push(e)
  });

  const r = await tool.handler(
    { projectId, name: "login", mode: "shared-cwd" },
    { threadId: "t1", wakeId: "w1", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } }
  );
  expect(r.ok).toBeTruthy();
  expect(r.featureName).toBe("login");
  expect(r.featureId).toBeTruthy();
  // SSE event broadcast happened.
  expect(events.length).toBe(1);
  expect(events[0]!.type).toBe("featureCreated");
  // DB has feature row.
  const row = env.features.getById(r.featureId!);
  expect(row).toBeTruthy();
  expect(row?.archivedAt).toBe(null);
});

test("create_feature (manager tool): points at the project's brief when it has one", async () => {
  const env = freshProjectEnv("md-cf-");
  const withBrief = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-test" });
  const without = seedProject(env.projects, { name: "beta", workingDir: env.dir, tmuxSessionName: "beta-test" });
  for (const id of [withBrief, without]) reconcileProject(env.projects.getById(id)!, [], tmuxReconcileAdapter(env.tmux.client));
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  memory.putBrief({ scope: "project", projectId: withBrief, content: "alpha brief", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z", runId: null });
  // Built the way the manager's packs are, so the hint is the real one.
  const tool = buildFeatureLifecycleToolPacks({
    agentStore: env.agentStore,
    projectsStore: env.projects,
    featuresStore: env.features,
    tmuxClient: env.tmux.client,
    gitClient: stub<GitClient>(),
    paneRuntimes: buildRegistry(env),
    publishLifecycle: () => {},
    memory
  }).flatMap((pack) => pack.tools).find((t) => t.name === "create_feature")!;
  const ctx = { threadId: "t1", wakeId: "w1", scope: { kind: "manager" as const, managerDir: "", projectWorkingDirs: [] } };
  expect(await tool.handler({ projectId: withBrief, name: "login", mode: "shared-cwd" }, ctx)).toMatchObject({
    ok: true,
    memory: 'alpha has memory: read its brief with memory_read({ target: "project", project: "alpha" }) before directing the worker.'
  });
  expect(await tool.handler({ projectId: without, name: "login", mode: "shared-cwd" }, ctx)).not.toHaveProperty("memory");
});

test("create_feature (manager tool): error for missing project", async () => {
  const env = freshProjectEnv("md-cf-");
  const tool = buildCreateFeatureTool({
    featuresStore: env.features,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    paneRuntimes: buildRegistry(env),
    broadcast: () => {}
  });
  const r = await tool.handler(
    { projectId: "nope", name: "x", mode: "shared-cwd" },
    { threadId: "t1", wakeId: "w1", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } }
  );
  expect(String(r.error)).toMatch(/project not found|project.*not found/i);
});
