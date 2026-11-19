import { expect, test } from "bun:test";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { buildActivityTestApp } from "./helpers/activity-app.js";

// Bun closes a connection that has sent nothing for 10 seconds. The
// Activity summary and the log's filter lists read every stored call in
// their window, which on a busy machine with a cold database has taken
// longer: the page then got no answer at all. Those two ask Bun for longer;
// the quick routes keep its limit.

async function timeoutsAsked(path: string) {
  const env = freshStoresEnv("md-activity-slow-");
  const app = buildActivityTestApp({ store: env.store });
  const asked: Array<[string, number]> = [];
  // What Bun hands every request as its server (Hono's env).
  const server = { timeout: (request: Request, seconds: number) => { asked.push([new URL(request.url).pathname, seconds]); } };
  const response = await app.request(path, undefined, server);
  expect(response.status).toBe(200);
  return asked;
}

test("the summary and the filter lists may take two minutes before Bun's idle limit closes them", async () => {
  expect(await timeoutsAsked("/api/activity/summary?days=30")).toEqual([["/api/activity/summary", 120]]);
  expect(await timeoutsAsked("/api/activity/filter-options")).toEqual([["/api/activity/filter-options", 120]]);
});

test("the log's page of calls keeps Bun's own limit", async () => {
  expect(await timeoutsAsked("/api/activity/calls?limit=20")).toEqual([]);
});
