import { afterEach, expect, test } from "bun:test";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { pageQuotesOf } from "../src/shared/page-quotes.js";
import { API_PATHS } from "../src/shared/api/routes.js";
import { freshStoresEnv, NOOP_WAKE, type StoresEnv } from "./helpers/fixtures.js";
import { buildAgentsTestApp, buildTestScopes, postJson } from "./helpers/test-app.js";

let env: StoresEnv | null = null;
afterEach(() => { env = null; });

function setup() {
  env = freshStoresEnv("md-http-page-quotes-");
  const managerThreads = new ManagerThreadService({ agentStore: env.agentStore });
  const app = buildAgentsTestApp({ agentStore: env.agentStore, wakeScheduler: NOOP_WAKE, scopes: buildTestScopes(env.workers), managerThreads });
  const personal = env.agentStore.getOrCreatePersonalThread();
  const manager = env.agentStore.createManagerThread("Release");
  const last = (threadId: string) => env!.agentStore.getActiveMessages(threadId).at(-1)!;
  return { app, personal, manager, last };
}

test("the personal agent's thread keeps a message's page quotes: folded, the same one once, at most 3, malformed ones dropped", async () => {
  const s = setup();
  const res = await postJson(s.app, API_PATHS.agentThreadMessages(s.personal.id), {
    content: "Can these wait?",
    pageQuotes: [
      { path: "index.html", text: "  Order #12\n\n waits " },
      { path: "index.html", text: "Order #12 waits" },
      { path: "", text: "no page" },
      { path: "index.html", text: "   " },
      { path: "index.html" },
      "nope",
      { path: "beds.html", text: "bed 3 dried out" },
      { path: "index.html", text: "Order more seed trays" },
      { path: "index.html", text: "One too many" }
    ]
  });
  expect(res.status).toBe(202);
  expect(pageQuotesOf(s.last(s.personal.id).content)).toEqual([
    { path: "index.html", text: "Order #12 waits" },
    { path: "beds.html", text: "bed 3 dried out" },
    { path: "index.html", text: "Order more seed trays" }
  ]);
});

test("a message to the personal agent may be quotes alone; with neither words nor quotes it is refused", async () => {
  const s = setup();
  const quoted = await postJson(s.app, API_PATHS.agentThreadMessages(s.personal.id), { content: "", pageQuotes: [{ path: "index.html", text: "Order #12 waits" }] });
  expect(quoted.status).toBe(202);
  const content = s.last(s.personal.id).content;
  expect(content.type === "text" ? content.text : null).toBe("");
  expect(pageQuotesOf(content)).toEqual([{ path: "index.html", text: "Order #12 waits" }]);
  const empty = await postJson(s.app, API_PATHS.agentThreadMessages(s.personal.id), { content: "", pageQuotes: [{ path: "index.html", text: "  " }] });
  expect(empty.status).toBe(400);
});

test("another thread takes no page quotes: they are dropped, and quotes alone are no message", async () => {
  const s = setup();
  const res = await postJson(s.app, API_PATHS.agentThreadMessages(s.manager.id), { content: "Status?", pageQuotes: [{ path: "index.html", text: "Order #12 waits" }] });
  expect(res.status).toBe(202);
  expect(pageQuotesOf(s.last(s.manager.id).content)).toEqual([]);
  const alone = await postJson(s.app, API_PATHS.agentThreadMessages(s.manager.id), { content: "", pageQuotes: [{ path: "index.html", text: "Order #12 waits" }] });
  expect(alone.status).toBe(400);
});
