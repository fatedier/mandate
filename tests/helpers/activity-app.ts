import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { AppDeps } from "../../src/server/app/deps.js";
import { activityModule } from "../../src/server/modules/activity/module.js";
import { stub } from "./typed.js";

/** The Activity module's routes alone, on the deps given (the store at
 *  least; whatever else a route reads). No error handler, as the tests that
 *  read its answers always had. */
export function buildActivityTestApp(deps: Partial<AppDeps>): Hono {
  const app = new Hono();
  activityModule.mountRoutes?.(app, { deps: stub<AppDeps>(deps), upgradeWebSocket: createBunWebSocket().upgradeWebSocket });
  return app;
}
