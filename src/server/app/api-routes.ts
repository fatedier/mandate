import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { mountRegisteredModuleRoutes } from "../modules/registry.js";
import type { AppDeps } from "./deps.js";

export function mountApiRoutes(app: Hono, upgradeWebSocket: UpgradeWebSocket, deps: AppDeps): void {
  // Sanity route — proves Hono is wired up.
  app.get("/api/_hono-ping", (c) => c.json({ ok: true, runtime: "bun+hono" }));

  mountRegisteredModuleRoutes(app, upgradeWebSocket, deps);

  // Anything under /api/* that wasn't matched above is a 404 — keep it JSON
  // so client fetch error paths stay consistent.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
}
