import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { startServer, type RunningServer } from "./helpers/server";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { seedProject } from "../tests/helpers/fixtures.js";
import { waitUntil } from "../tests/helpers/wait.js";

// The compiled binary, booted on a database that already holds two worker
// threads with an alarm due a few seconds after start: one whose feature was
// archived, one whose feature is live. This is what the runtime's wiring has
// to get right — the unit tests cover the guard and the scheduler, not that
// the runtime hands the guard to both.

const DUE_IN_MS = 4000;
let server: RunningServer;
let threads: { retired: string; live: string };

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      const store = new MandateStore(dataDir);
      const projects = new ProjectsStore(store.db);
      const features = new FeaturesStore(store.db);
      const agents = new AgentStore(store.db);
      const projectId = seedProject(projects, { name: "Alarm project", tmuxSessionName: "md-alarm-project" });
      const insertFeature = (name: string) => features.insert({
        projectId, name, mode: "shared-cwd", branch: null, worktreePath: null,
        tmuxWindowName: name, ownership: "app"
      });
      const retiredFeature = insertFeature("retired");
      const liveFeature = insertFeature("live");
      threads = {
        retired: agents.getOrCreateThread("worker", retiredFeature).id,
        live: agents.getOrCreateThread("worker", liveFeature).id
      };
      features.archive(retiredFeature);
      const fireAt = new Date(Date.now() + DUE_IN_MS).toISOString();
      const insert = store.db.prepare(
        "insert into agent_alarms (id, thread_id, fire_at, note, status, created_at) values (?, ?, ?, ?, 'pending', ?)"
      );
      insert.run("alm_retired_1", threads.retired, fireAt, "poll the PR again", new Date().toISOString());
      insert.run("alm_retired_2", threads.retired, new Date(Date.now() + 3_600_000).toISOString(), "and again", new Date().toISOString());
      insert.run("alm_live", threads.live, fireAt, "check the build", new Date().toISOString());
      store.db.close();
    }
  });
});

afterAll(() => server?.cleanup());

function readState() {
  const db = new Database(path.join(server.dataDir, "mandate.db"), { readonly: true });
  try {
    const alarms = Object.fromEntries(
      (db.prepare("select id, status from agent_alarms").all() as Array<{ id: string; status: string }>).map((r) => [r.id, r.status])
    );
    const wakes = (threadId: string) =>
      (db.prepare("select count(*) c from agent_wakes where thread_id = ?").get(threadId) as { c: number }).c;
    const alarmMessages = (threadId: string) =>
      (db.prepare("select count(*) c from agent_messages where thread_id = ? and source = 'alarm'").get(threadId) as { c: number }).c;
    return {
      alarms,
      retired: { wakes: wakes(threads.retired), alarmMessages: alarmMessages(threads.retired) },
      live: { wakes: wakes(threads.live), alarmMessages: alarmMessages(threads.live) }
    };
  } finally {
    db.close();
  }
}

test("a due alarm on an archived feature is cancelled, with its thread's later ones; a live feature's still fires", async () => {
  // The live thread's wake is started after its alarm row is marked fired,
  // and retried when the thread is busy: wait for it, not just the row.
  const state = await waitUntil(() => {
    const now = readState();
    return now.alarms.alm_live !== "pending" && now.alarms.alm_retired_1 !== "pending" && now.live.wakes >= 1 ? now : null;
  }, { timeout: DUE_IN_MS + 15_000, interval: 250, label: () => `both due alarms to leave pending and the live thread to wake (now ${JSON.stringify(readState())})` });
  // The control first: the harness does see an alarm fire and wake its thread.
  expect(state.alarms.alm_live).toBe("fired");
  expect(state.live.alarmMessages).toBe(1);
  expect(state.live.wakes).toBeGreaterThanOrEqual(1);
  // The archived feature's thread: cancelled, nothing written, never woken.
  expect([state.alarms.alm_retired_1, state.alarms.alm_retired_2]).toEqual(["canceled", "canceled"]);
  expect(state.retired).toEqual({ wakes: 0, alarmMessages: 0 });
}, 60_000);
