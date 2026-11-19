import { expect, test } from "bun:test";
import { freshProjectEnv, NOOP_WAKE } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/temp.js";
import { toolContext } from "../helpers/typed.js";
import { buildAgentsTestApp, buildProjectsTestApp, buildTestScopes, patchJson, postJson } from "../helpers/test-app.js";
import { TmuxRuntime } from "../../src/server/runtime/runtimes/tmux-runtime.js";
import { buildCreateWorkerTool } from "../../src/server/modules/workers/tools/create-worker.js";
import { buildArchiveWorkerTool } from "../../src/server/modules/workers/tools/archive-worker.js";
import { buildRestoreWorkerTool } from "../../src/server/modules/workers/tools/restore-worker.js";
import { buildWorkerMessageSendTool } from "../../src/server/modules/agent/tools/worker-message-tools.js";
import { ManagerThreadService } from "../../src/server/modules/agent/manager-threads.js";
import { ThreadArchive } from "../../src/server/modules/agent/thread-archive.js";
import { WorkerService } from "../../src/server/modules/workers/worker-service.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../../src/server/modules/plans/plan-store.js";
import { reportWorkerWakeEnd } from "../../src/server/runtime/worker-report.js";
import { workerReportOf } from "../../src/shared/worker-report.js";
import { recordingInbox } from "../helpers/upward-inbox.js";

test("a worker a thread starts belongs to it: others are refused, reports go there, and the thread's archive takes it along", async () => {
  const wd = tempDir("md-own-flow-wd-");
  const env = freshProjectEnv("md-own-flow-");
  const tmuxRuntime = new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers });
  const projectsApp = buildProjectsTestApp({ projects: env.projects, workers: env.workers, tmuxClient: env.tmux.client, broadcast: () => {} });
  const project = await postJson(projectsApp, "/api/projects", { name: "project-1", workingDir: wd });
  expect(project.status).toBe(200);

  const a = env.agentStore.createManagerThread("project-2 cache expiry");
  const b = env.agentStore.createManagerThread("Sidebar");
  const ctx = (threadId: string) => toolContext({ threadId, wakeId: "wk" });
  const toolDeps = {
    workersStore: env.workers, projectsStore: env.projects, agentStore: env.agentStore,
    tmuxClient: env.tmux.client, tmuxRuntime, broadcast: () => {}
  };

  // A starts the worker, and owns it.
  const created = await buildCreateWorkerTool(toolDeps).handler(
    { projectId: project.body.id, name: "EvictHook", mode: "shared-cwd" }, ctx(a.id)
  );
  expect(created.error).toBeUndefined();
  const workerId = created.workerId!;
  expect(env.workers.getById(workerId)?.ownerThreadId).toBe(a.id);

  // B may not direct it.
  const send = buildWorkerMessageSendTool({ agentStore: env.agentStore, workersStore: env.workers, wakeScheduler: NOOP_WAKE });
  expect(await send.handler({ workerId: workerId, message: "go" }, ctx(b.id)))
    .toEqual({ error: 'Worker "EvictHook" belongs to the thread "project-2 cache expiry". Ask the user to continue there.' });

  // Its wake ends with a question in its plan: one report, to A.
  const workStore = new WorkItemStore(env.store.db);
  new PlanStore(env.store.db).update(workerId, { openQuestions: ["Keep the old flag as an alias?"] });
  const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
  const { inbox, wakes } = recordingInbox(env.agentStore);
  reportWorkerWakeEnd({
    agentStore: env.agentStore, workersStore: env.workers, projectsStore: env.projects,
    workStore, planStore: new PlanStore(env.store.db), inbox
  }, { threadId: workerThread.id, status: "finished", errorMessage: null });
  const reports = env.store.db
    .prepare("select thread_id, content from agent_mailbox where source = 'worker-report'")
    .all() as Array<{ thread_id: string; content: string }>;
  expect(reports.map((r) => r.thread_id)).toEqual([a.id]);
  expect(workerReportOf(JSON.parse(reports[0]!.content))).toMatchObject({ workerId: workerId, key: "input" });
  expect(wakes.map((w) => w.threadId)).toStrictEqual([a.id]);

  // B may not archive A's worker.
  const archive = buildArchiveWorkerTool(toolDeps);
  expect((await archive.handler({ workerId: workerId }, ctx(b.id))).error).toContain("belongs to the thread");
  expect(env.workers.getById(workerId)?.archivedAt).toBe(null);

  // A's own archive takes its worker with it (shared-cwd has no worktree
  // to check), through the worker's real archive: every page is told.
  const told: string[] = [];
  const managerThreads = new ManagerThreadService({ agentStore: env.agentStore });
  const agentsApp = buildAgentsTestApp({
    agentStore: env.agentStore,
    wakeScheduler: NOOP_WAKE,
    scopes: buildTestScopes(env.workers),
    managerThreads,
    threadArchive: new ThreadArchive({
      agentStore: env.agentStore,
      workerStore: env.workers,
      workers: new WorkerService({ projects: env.projects, workers: env.workers, tmuxClient: env.tmux.client, tmuxRuntime, agentStore: env.agentStore }),
      wakes: { getRunningWakeForThread: () => null, cancelWake: () => {} },
      releaseThreadResources: () => {},
      beforeThreadArchive: () => {},
      broadcast: (event) => { told.push(`${event.type} ${(event.data as { id: string }).id}`); },
      publishThread: (threadId) => managerThreads.publish(threadId)
    })
  });
  const archived = await patchJson(agentsApp, `/api/agents/manager/threads/${a.id}`, { archived: true });
  expect(archived.status).toBe(200);
  expect(archived.body.workers).toEqual([{ id: workerId, name: "EvictHook" }]);
  expect(told).toStrictEqual([`workerArchived ${workerId}`]);
  expect(env.workers.getById(workerId)?.archivedAt === null).toBe(false);
  expect(env.agentStore.getThreadById(a.id)?.archivedAt === null).toBe(false);
  // B, which owned nothing, is untouched.
  expect(env.agentStore.getThreadById(b.id)?.archivedAt).toBe(null);
});

test("a worker restored by another thread is that thread's before anything announces it", async () => {
  const wd = tempDir("md-restore-owner-wd-");
  const env = freshProjectEnv("md-restore-owner-");
  const tmuxRuntime = new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers });
  const project = await postJson(buildProjectsTestApp({ projects: env.projects, workers: env.workers, tmuxClient: env.tmux.client, broadcast: () => {} }), "/api/projects", { name: "project-1", workingDir: wd });
  const a = env.agentStore.createManagerThread("A");
  const b = env.agentStore.createManagerThread("B");
  const ctx = (threadId: string) => toolContext({ threadId, wakeId: "wk" });
  const toolDeps = {
    workersStore: env.workers, projectsStore: env.projects, agentStore: env.agentStore,
    tmuxClient: env.tmux.client, tmuxRuntime, broadcast: () => {}
  };
  const created = await buildCreateWorkerTool(toolDeps).handler({ projectId: project.body.id, name: "EvictHook", mode: "shared-cwd" }, ctx(a.id));
  const workerId = created.workerId!;
  env.workers.archive(workerId);

  // Each announcement arms the sweep of whoever owns the worker right then.
  const ownersAtAnnouncement: Array<string | null> = [];
  env.workers.onWorkItemChange((e) => ownersAtAnnouncement.push(env.workers.getById(e.workerId)?.ownerThreadId ?? null));
  // A new window name: the store-level archive above left the old window up.
  expect(await buildRestoreWorkerTool(toolDeps).handler({ workerId: workerId, tmuxWindowName: "evicthook-2" }, ctx(b.id))).toMatchObject({ ok: true });
  expect(env.workers.getById(workerId)?.ownerThreadId).toBe(b.id);
  expect(ownersAtAnnouncement.length > 0).toBe(true);
  // A ended its sweep or not, it has nothing here any more: it is never armed.
  expect(ownersAtAnnouncement.filter((o) => o !== b.id)).toStrictEqual([]);
});
