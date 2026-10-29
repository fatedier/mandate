import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ProjectService } from "../src/server/modules/projects/project-service.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux-commands.js";
import { freshStoresEnv, seedFeature, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";

const OUTER = "the outer transaction fails after the write";

/** Runs `write` inside a transaction that then fails, and returns why it
 *  failed: OUTER when the write joined it, anything else when the write could
 *  not run inside a transaction at all. */
function inFailingTransaction(db: Database, write: () => void): string {
  try {
    db.transaction(() => {
      write();
      throw new Error(OUTER);
    }).immediate();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "no error";
}

const wakeColumn = (env: StoresEnv, wakeId: string, column: "status" | "cancel_requested_at") =>
  (env.store.db.prepare(`select ${column} as value from agent_wakes where id = ?`).get(wakeId) as { value: string | null }).value;

function runningWake(env: StoresEnv) {
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const wake = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  return { thread, wake };
}

// Each of these opened its own transaction with `begin immediate`, which
// throws inside any other: "cannot start a transaction within a transaction".
const writes: Array<[string, (env: StoresEnv) => { write: () => void; untouched: () => void }]> = [
  ["FeaturesStore.insert", (env) => {
    const projectId = seedProject(env.projects);
    return {
      write: () => { seedFeature(env.features, projectId, { name: "G", tmuxWindowName: "g" }); },
      untouched: () => expect(env.features.listActiveByProject(projectId).length).toBe(0)
    };
  }],
  ["FeaturesStore.archive", (env) => {
    const featureId = seedFeature(env.features, seedProject(env.projects));
    return { write: () => env.features.archive(featureId), untouched: () => expect(env.features.getById(featureId)!.archivedAt).toBeNull() };
  }],
  ["FeaturesStore.restore", (env) => {
    const featureId = seedFeature(env.features, seedProject(env.projects));
    env.features.archive(featureId);
    return {
      write: () => env.features.restore({ id: featureId, mode: "shared-cwd", branch: null, baseRef: null, worktreePath: null, tmuxWindowName: "f" }),
      untouched: () => expect(env.features.getById(featureId)!.archivedAt === null).toBe(false)
    };
  }],
  ["FeaturesStore.archiveByProjectId", (env) => {
    const projectId = seedProject(env.projects);
    const featureId = seedFeature(env.features, projectId);
    return { write: () => env.features.archiveByProjectId(projectId), untouched: () => expect(env.features.getById(featureId)!.archivedAt).toBeNull() };
  }],
  ["ProjectsStore.archive", (env) => {
    const projectId = seedProject(env.projects);
    return { write: () => env.projects.archive(projectId), untouched: () => expect(env.projects.getById(projectId)!.archivedAt).toBeNull() };
  }],
  ["AgentStore.requestWakeCancellation", (env) => {
    const { wake } = runningWake(env);
    return { write: () => env.agentStore.requestWakeCancellation(wake.id), untouched: () => expect(wakeColumn(env, wake.id, "cancel_requested_at")).toBeNull() };
  }],
  ["AgentStore.drainMailboxToMessages", (env) => {
    const { thread, wake } = runningWake(env);
    env.agentStore.enqueueMailboxMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Next step" } });
    return {
      write: () => { env.agentStore.drainMailboxToMessages(thread.id, wake.id); },
      untouched: () => {
        expect(env.agentStore.hasQueuedMailboxMessages(thread.id)).toBe(true);
        expect(env.agentStore.getActiveMessages(thread.id).length).toBe(0);
      }
    };
  }],
  ["AgentStore.recoverInterruptedWakes", (env) => {
    const { wake } = runningWake(env);
    return { write: () => { env.agentStore.recoverInterruptedWakes("server restarted"); }, untouched: () => expect(wakeColumn(env, wake.id, "status")).toBe("running") };
  }]
];

for (const [name, arrange] of writes) {
  test(`${name} joins a transaction already open, and rolls back with it`, () => {
    const env = freshStoresEnv("md-store-tx-");
    const { write, untouched } = arrange(env);
    expect(inFailingTransaction(env.store.db, write)).toBe(OUTER);
    untouched();
  });
}

test("archiving a project archives its workers and the project together: a write that fails leaves both as they were", async () => {
  const env = freshStoresEnv("md-store-tx-");
  const projectId = seedProject(env.projects);
  const featureId = seedFeature(env.features, projectId);
  // A real failure from SQLite on the project's own write, after its
  // workers' write has run.
  env.store.db.exec(`create trigger fail_project_archive before update of archived_at on projects
      begin select raise(abort, 'disk I/O error'); end`);
  const service = new ProjectService({ projects: env.projects, features: env.features, tmuxClient: stub<TmuxClient>({}) });
  let failure = "";
  try { await service.archive({ id: projectId }); } catch (err) { failure = err instanceof Error ? err.message : String(err); }
  expect(failure).toContain("disk I/O error");
  expect(env.projects.getById(projectId)!.archivedAt).toBeNull();
  expect(env.features.getById(featureId)!.archivedAt).toBeNull();
});
