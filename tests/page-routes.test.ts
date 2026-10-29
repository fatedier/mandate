import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { mountPageRoutes } from "../src/server/modules/page/page-routes.js";
import { API_PATHS, API_ROUTES } from "../src/shared/api-contracts.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

test("the page's state and its versions are read by revision; an unknown one is 404", async () => {
  env = freshStoresEnv("md-page-routes-");
  const pageStore = new PageStore(env.store.db);
  const app = new Hono();
  mountPageRoutes(app, { pageStore });
  expect(await (await app.request(API_ROUTES.agentPage)).json()).toEqual({ latest: null, write: null });
  pageStore.publish("<h1>Today</h1>", "agent");
  const state = await (await app.request(API_ROUTES.agentPage)).json() as { latest: { revision: number; writer: string } };
  expect(state.latest).toMatchObject({ revision: 1, writer: "agent" });
  expect(await (await app.request(API_PATHS.agentPageVersion(1))).json()).toMatchObject({ revision: 1, html: "<h1>Today</h1>" });
  for (const missing of ["/api/agent-page/versions/2", "/api/agent-page/versions/abc", "/api/agent-page/versions/1.5"]) {
    expect((await app.request(missing)).status).toBe(404);
  }
});
