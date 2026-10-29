import type { Hono } from "hono";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { GlobalAgentService } from "./global-agent-service.js";

export function mountGlobalAgentRoutes(app: Hono, deps: { globalAgent: GlobalAgentService }): void {
  const service = deps.globalAgent;
  app.get(API_ROUTES.agentGlobal, (c) => c.json({ agent: service.state() }));
  app.get(API_ROUTES.agentGlobalHandoffs, (c) => {
    // By id: the cards a transcript shows.
    const ids = (c.req.query("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    return c.json({ handoffs: service.handoffsByIds(ids) });
  });
  app.post(API_ROUTES.agentGlobalSeen, async (c) => {
    const body = await c.req.json().catch(() => null) as { seq?: unknown } | null;
    const result = service.markSeen(body?.seq);
    return "error" in result ? c.json(result, 400) : c.json({ agent: result });
  });
}
