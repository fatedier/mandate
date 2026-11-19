import type { Hono } from "hono";
import { API_ROUTES, type TmuxSessionsResponse } from "../../../shared/api-contracts.js";
import { SessionService, type SessionsApiDeps } from "./session-service.js";

export function mountSessionsRoutes(app: Hono, deps: SessionsApiDeps): void {
  const sessions = new SessionService(deps);

  app.get(API_ROUTES.tmuxSessions, async (c) => {
    return c.json({ sessions: await sessions.listSessions() } satisfies TmuxSessionsResponse);
  });

  app.get(API_ROUTES.terminalWindow, async (c) => {
    if (!sessions.hasRawState()) return c.json({ error: "tmux state unavailable" }, 503);

    const window = await sessions.getWindow(c.req.param("windowId"));
    if (!window) return c.json({ error: "window not found" }, 404);
    return c.json({ window });
  });
}
