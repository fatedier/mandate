import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ThreadTabStore, mountThreadTabRoutes } from "../src/server/modules/personal/thread-tabs.js";
import { API_PATHS, API_ROUTES } from "../src/shared/api/routes.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { deleteJson, getJson, postJson } from "./helpers/test-app.js";

// The threads opened beside the personal agent are kept on the server, so every
// device shows the same tabs; each change says so on the event stream.

function setup(prefix: string) {
  const env = freshStoresEnv(prefix);
  const agent = env.agentStore;
  const events: Array<{ event: string; data: unknown }> = [];
  const store = new ThreadTabStore(env.store.db);
  const app = new Hono();
  mountThreadTabRoutes(app, { store, agentStore: agent, sse: { emit: (event, data) => { events.push({ event, data }); } } });
  return { env, agent, store, app, events };
}

const threadIds = (body: { tabs: Array<{ threadId: string }> }) => body.tabs.map((tab) => tab.threadId);

test("open, list and close a thread beside the personal agent, each change sending threadTabsChanged", async () => {
  const s = setup("md-thread-tabs-");
  const release = s.agent.createManagerThread("Release 3.21").id;
  const added = await postJson(s.app, API_ROUTES.agentPersonalThreadTabs, { threadId: release });
  expect(added.status).toBe(200);
  expect(added.body.tabs).toHaveLength(1);
  expect(added.body.tabs[0]).toMatchObject({ threadId: release });
  expect(typeof added.body.tabs[0].createdAt).toBe("string");
  expect((await getJson(s.app, API_ROUTES.agentPersonalThreadTabs)).body).toEqual(added.body);
  const removed = await deleteJson(s.app, API_PATHS.agentPersonalThreadTab(release));
  expect(removed).toEqual({ status: 200, body: { tabs: [] } });
  expect(s.events).toEqual([
    { event: SSE_EVENTS.threadTabsChanged, data: {} },
    { event: SSE_EVENTS.threadTabsChanged, data: {} }
  ]);
  expect((await deleteJson(s.app, API_PATHS.agentPersonalThreadTab(release))).status).toBe(404);
  expect(s.events).toHaveLength(2);
});

test("opening a thread twice keeps one tab and says nothing the second time", async () => {
  const s = setup("md-thread-tabs-twice-");
  const docs = s.agent.createManagerThread("Docs layout").id;
  const first = await postJson(s.app, API_ROUTES.agentPersonalThreadTabs, { threadId: docs });
  const second = await postJson(s.app, API_ROUTES.agentPersonalThreadTabs, { threadId: docs });
  expect(second).toEqual(first);
  expect(s.events).toHaveLength(1);
});

test("tabs list in the order opened; an archived thread keeps its tab and can be opened", async () => {
  const s = setup("md-thread-tabs-order-");
  const older = s.agent.createManagerThread("Billing migration").id;
  const newer = s.agent.createManagerThread("CI speed-up").id;
  await postJson(s.app, API_ROUTES.agentPersonalThreadTabs, { threadId: newer });
  const both = await postJson(s.app, API_ROUTES.agentPersonalThreadTabs, { threadId: older });
  expect(threadIds(both.body)).toEqual([newer, older]);
  s.agent.archiveThread(newer);
  expect(threadIds((await getJson(s.app, API_ROUTES.agentPersonalThreadTabs)).body)).toEqual([newer, older]);
  const archived = s.agent.createManagerThread("Old release").id;
  s.agent.archiveThread(archived);
  expect((await postJson(s.app, API_ROUTES.agentPersonalThreadTabs, { threadId: archived })).status).toBe(200);
});

test("refuses what is not a manager thread, and a body without a thread id", async () => {
  const s = setup("md-thread-tabs-refused-");
  const post = (body: unknown) => postJson(s.app, API_ROUTES.agentPersonalThreadTabs, body);
  const personal = s.agent.getOrCreatePersonalThread().id;
  const workerId = seedWorker(s.env.workers, seedProject(s.env.projects));
  const worker = s.agent.getOrCreateThread("worker", workerId).id;
  expect((await post({ threadId: personal })).status).toBe(404);
  expect((await post({ threadId: worker })).status).toBe(404);
  expect((await post({ threadId: "thr_missing" })).status).toBe(404);
  expect((await post({ threadId: 42 })).status).toBe(400);
  expect((await post({})).status).toBe(400);
  expect(s.events).toEqual([]);
  expect(s.store.list()).toEqual([]);
});
