import { expect, test } from "bun:test";
import { Hono } from "hono";
import { INVALID_JSON, readJsonBody } from "../src/server/platform/http/json-body.js";
import { analysisModule } from "../src/server/modules/analysis/module.js";
import { buildProjectsTestApp } from "./helpers/test-app.js";
import { freshProjectEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";

const post = (app: Hono, path: string, body: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body });

test("a request body is its JSON, and anything else is INVALID_JSON", async () => {
  const app = new Hono();
  const seen: unknown[] = [];
  app.post("/x", async (c) => { seen.push(await readJsonBody(c)); return c.body(null, 204); });
  await post(app, "/x", JSON.stringify({ a: 1 }));
  await post(app, "/x", "not json");
  await post(app, "/x", "");
  expect(seen).toStrictEqual([{ a: 1 }, INVALID_JSON, INVALID_JSON]);
});

test("a route answers a body that is not JSON with its own 400", async () => {
  // The two envelopes routes use: `{ error }` and `{ ok: false, error }`.
  const env = freshProjectEnv("md-json-body-");
  const projects = buildProjectsTestApp({
    projects: env.projects, features: env.features, tmuxClient: env.tmux.client, broadcast: () => {}
  });
  const res = await post(projects, "/api/projects", "{ not json");
  expect([res.status, await res.json()]).toEqual([400, { error: "invalid JSON" }]);

  const windows = new Hono();
  analysisModule.mountRoutes!(windows, stub<Parameters<NonNullable<typeof analysisModule.mountRoutes>>[1]>({}));
  const inspect = await post(windows, "/api/windows/inspect", "{ not json");
  expect([inspect.status, await inspect.json()]).toEqual([400, { ok: false, error: "invalid JSON" }]);
});
