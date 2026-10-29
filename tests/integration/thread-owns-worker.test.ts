import { expect, test } from "bun:test";
import { freshProjectEnv, NOOP_WAKE } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/temp.js";
import { toolContext } from "../helpers/typed.js";
import { buildAgentsTestApp, buildProjectsTestApp, buildTestScopes, postJson } from "../helpers/test-app.js";
import { buildPaneRuntimes } from "../../src/server/runtime/pane-runtime-registry.js";
import { buildCreateFeatureTool } from "../../src/server/modules/features/tools/create-feature.js";
import { buildArchiveFeatureTool } from "../../src/server/modules/features/tools/archive-feature.js";
import { buildRestoreFeatureTool } from "../../src/server/modules/features/tools/restore-feature.js";
import { buildFeatureMessageSendTool } from "../../src/server/modules/agent/tools/feature-message-tools.js";
import { ManagerThreadService } from "../../src/server/modules/agent/manager-threads.js";
import { ThreadArchive } from "../../src/server/modules/agent/thread-archive.js";
import { FeatureService } from "../../src/server/modules/features/feature-service.js";
import { WorkItemStore } from "../../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../../src/server/modules/plans/plan-store.js";
import { reportWorkerWakeEnd } from "../../src/server/runtime/worker-report.js";
import { workerReportOf } from "../../src/shared/worker-report.js";
import { recordingInbox } from "../helpers/upward-inbox.js";

async function patchJson(app: ReturnType<typeof buildAgentsTestApp>, url: string, body: unknown) {
  const res = await app.request(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("a worker a thread starts belongs to it: others are refused, reports go there, and the thread's archive takes it along", async () => {
  const wd = tempDir("md-own-flow-wd-");
  const env = freshProjectEnv("md-own-flow-");
  const paneRuntimes = buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features });
  const projectsApp = buildProjectsTestApp({ projects: env.projects, features: env.features, tmuxClient: env.tmux.client, broadcast: () => {} });
  const project = await postJson(projectsApp, "/api/projects", { name: "project-1", workingDir: wd });
  expect(project.status).toBe(200);

  const a = env.agentStore.createManagerThread("project-2 cache expiry");
  const b = env.agentStore.createManagerThread("Sidebar");
  const ctx = (threadId: string) => toolContext({ threadId, wakeId: "wk" });
  const toolDeps = {
    featuresStore: env.features, projectsStore: env.projects, agentStore: env.agentStore,
    tmuxClient: env.tmux.client, paneRuntimes, broadcast: () => {}
  };

  // A starts the worker, and owns it.
  const created = await buildCreateFeatureTool(toolDeps).handler(
    { projectId: project.body.id, name: "EvictHook", mode: "shared-cwd" }, ctx(a.id)
  );
  expect(created.error).toBeUndefined();
  const featureId = created.featureId!;
  expect(env.features.getById(featureId)?.ownerThreadId).toBe(a.id);

  // B may not direct it.
  const send = buildFeatureMessageSendTool({ agentStore: env.agentStore, featuresStore: env.features, wakeScheduler: NOOP_WAKE });
  expect(await send.handler({ featureId, message: "go" }, ctx(b.id)))
    .toEqual({ error: 'Worker "EvictHook" belongs to the thread "project-2 cache expiry". Ask the user to continue there.' });

  // Its wake ends with a question in its plan: one report, to A.
  const workStore = new WorkItemStore(env.store.db);
  new PlanStore(env.store.db).update(featureId, { openQuestions: ["Keep the old flag as an alias?"] });
  const workerThread = env.agentStore.getOrCreateThread("worker", featureId);
  const { inbox, wakes } = recordingInbox(env.agentStore);
  reportWorkerWakeEnd({
    agentStore: env.agentStore, featuresStore: env.features, projectsStore: env.projects,
    workStore, planStore: new PlanStore(env.store.db), inbox
  }, { threadId: workerThread.id, status: "finished", errorMessage: null });
  const reports = env.store.db
    .prepare("select thread_id, content from agent_mailbox where source = 'worker-report'")
    .all() as Array<{ thread_id: string; content: string }>;
  expect(reports.map((r) => r.thread_id)).toEqual([a.id]);
  expect(workerReportOf(JSON.parse(reports[0]!.content))).toMatchObject({ featureId, key: "input" });
  expect(wakes.map((w) => w.threadId)).toStrictEqual([a.id]);

  // B may not archive A's worker.
  const archive = buildArchiveFeatureTool(toolDeps);
  expect((await archive.handler({ featureId }, ctx(b.id))).error).toContain("belongs to the thread");
  expect(env.features.getById(featureId)?.archivedAt).toBe(null);

  // A's own archive takes its worker with it (shared-cwd has no worktree
  // to check), through the worker's real archive: every page is told.
  const told: string[] = [];
  const managerThreads = new ManagerThreadService({ agentStore: env.agentStore });
  const agentsApp = buildAgentsTestApp({
    agentStore: env.agentStore,
    wakeScheduler: NOOP_WAKE,
    scopes: buildTestScopes(env.features),
    managerThreads,
    threadArchive: new ThreadArchive({
      agentStore: env.agentStore,
      features: env.features,
      workers: new FeatureService({ projects: env.projects, features: env.features, tmuxClient: env.tmux.client, paneRuntimes, agentStore: env.agentStore }),
      wakes: { getRunningWakeForThread: () => null, cancelWake: () => {} },
      releaseThreadResources: () => {},
      beforeThreadArchive: () => {},
      broadcast: (event) => { told.push(`${event.type} ${(event.data as { id: string }).id}`); },
      publishThread: (threadId) => managerThreads.publish(threadId)
    })
  });
  const archived = await patchJson(agentsApp, `/api/agents/manager/threads/${a.id}`, { archived: true });
  expect(archived.status).toBe(200);
  expect(archived.body.workers).toEqual([{ id: featureId, name: "EvictHook" }]);
  expect(told).toStrictEqual([`featureArchived ${featureId}`]);
  expect(env.features.getById(featureId)?.archivedAt === null).toBe(false);
  expect(env.agentStore.getThreadById(a.id)?.archivedAt === null).toBe(false);
  // B, which owned nothing, is untouched.
  expect(env.agentStore.getThreadById(b.id)?.archivedAt).toBe(null);
});

test("a worker restored by another thread is that thread's before anything announces it", async () => {
  const wd = tempDir("md-restore-owner-wd-");
  const env = freshProjectEnv("md-restore-owner-");
  const paneRuntimes = buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features });
  const project = await postJson(buildProjectsTestApp({ projects: env.projects, features: env.features, tmuxClient: env.tmux.client, broadcast: () => {} }), "/api/projects", { name: "project-1", workingDir: wd });
  const a = env.agentStore.createManagerThread("A");
  const b = env.agentStore.createManagerThread("B");
  const ctx = (threadId: string) => toolContext({ threadId, wakeId: "wk" });
  const toolDeps = {
    featuresStore: env.features, projectsStore: env.projects, agentStore: env.agentStore,
    tmuxClient: env.tmux.client, paneRuntimes, broadcast: () => {}
  };
  const created = await buildCreateFeatureTool(toolDeps).handler({ projectId: project.body.id, name: "EvictHook", mode: "shared-cwd" }, ctx(a.id));
  const featureId = created.featureId!;
  env.features.archive(featureId);

  // Each announcement arms the sweep of whoever owns the worker right then.
  const ownersAtAnnouncement: Array<string | null> = [];
  env.features.onWorkItemChange((e) => ownersAtAnnouncement.push(env.features.getById(e.featureId)?.ownerThreadId ?? null));
  // A new window name: the store-level archive above left the old window up.
  expect(await buildRestoreFeatureTool(toolDeps).handler({ featureId, tmuxWindowName: "evicthook-2" }, ctx(b.id))).toMatchObject({ ok: true });
  expect(env.features.getById(featureId)?.ownerThreadId).toBe(b.id);
  expect(ownersAtAnnouncement.length > 0).toBe(true);
  // A ended its sweep or not, it has nothing here any more: it is never armed.
  expect(ownersAtAnnouncement.filter((o) => o !== b.id)).toStrictEqual([]);
});
