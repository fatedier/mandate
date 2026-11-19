import { expect, test } from "bun:test";
import { reconcileProject } from "../src/server/modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../src/server/modules/projects/tmux-reconcile-adapter.js";
import { buildCreateWorkerTool } from "../src/server/modules/workers/tools/create-worker.js";
import { buildWorkerLifecycleToolPacks } from "../src/server/modules/workers/worker-tool-packs.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import type { GitClient } from "../src/server/platform/git/git.js";
import { stub } from "./helpers/typed.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { freshProjectEnv, seedProject } from "./helpers/fixtures.js";

function buildRuntime(env: ReturnType<typeof freshProjectEnv>) {
  return new TmuxRuntime({
    tmuxClient: env.tmux.client,
    projectsStore: env.projects,
    workersStore: env.workers
  });
}

test("create_worker (manager tool): creates worker row + tmux window", async () => {
  const env = freshProjectEnv("md-cf-");
  const projectId = seedProject(env.projects, {
    name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-test"
  });
  const project = env.projects.getById(projectId)!;
  await reconcileProject(project, [], tmuxReconcileAdapter(env.tmux.client));

  const events: any[] = [];
  const tool = buildCreateWorkerTool({
    workersStore: env.workers,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    tmuxRuntime: buildRuntime(env),
    broadcast: (e) => events.push(e)
  });

  const r = await tool.handler(
    { projectId, name: "login", mode: "shared-cwd" },
    { threadId: "t1", wakeId: "w1", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } }
  );
  expect(r.ok).toBeTruthy();
  expect(r.workerName).toBe("login");
  expect(r.workerId).toBeTruthy();
  // SSE event broadcast happened.
  expect(events.length).toBe(1);
  expect(events[0]!.type).toBe("workerCreated");
  // DB has worker row.
  const row = env.workers.getById(r.workerId!);
  expect(row).toBeTruthy();
  expect(row?.archivedAt).toBe(null);
});

test("create_worker (manager tool): points at the project's brief when it has one", async () => {
  const env = freshProjectEnv("md-cf-");
  const withBrief = seedProject(env.projects, { name: "alpha", workingDir: env.dir, tmuxSessionName: "alpha-test" });
  const without = seedProject(env.projects, { name: "beta", workingDir: env.dir, tmuxSessionName: "beta-test" });
  for (const id of [withBrief, without]) await reconcileProject(env.projects.getById(id)!, [], tmuxReconcileAdapter(env.tmux.client));
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  memory.putBrief({ scope: "project", projectId: withBrief, content: "alpha brief", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z" });
  // Built the way the manager's packs are, so the hint is the real one.
  const tool = buildWorkerLifecycleToolPacks({
    agentStore: env.agentStore,
    projectsStore: env.projects,
    workersStore: env.workers,
    tmuxClient: env.tmux.client,
    gitClient: stub<GitClient>(),
    tmuxRuntime: buildRuntime(env),
    publishLifecycle: () => {},
    memory
  }).flatMap((pack) => pack.tools).find((t) => t.name === "create_worker")!;
  const ctx = { threadId: "t1", wakeId: "w1", scope: { kind: "manager" as const, managerDir: "", projectWorkingDirs: [] } };
  expect(await tool.handler({ projectId: withBrief, name: "login", mode: "shared-cwd" }, ctx)).toMatchObject({
    ok: true,
    memory: 'alpha has memory: read its brief with memory_read({ target: "project", project: "alpha" }) before directing the worker.'
  });
  expect(await tool.handler({ projectId: without, name: "login", mode: "shared-cwd" }, ctx)).not.toHaveProperty("memory");
});

test("create_worker (manager tool): error for missing project", async () => {
  const env = freshProjectEnv("md-cf-");
  const tool = buildCreateWorkerTool({
    workersStore: env.workers,
    projectsStore: env.projects,
    agentStore: env.agentStore,
    tmuxClient: env.tmux.client,
    tmuxRuntime: buildRuntime(env),
    broadcast: () => {}
  });
  const r = await tool.handler(
    { projectId: "nope", name: "x", mode: "shared-cwd" },
    { threadId: "t1", wakeId: "w1", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } }
  );
  expect(String(r.error)).toMatch(/project not found|project.*not found/i);
});
