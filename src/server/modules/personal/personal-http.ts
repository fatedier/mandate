import type { Hono } from "hono";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { PersonalAgentService } from "./personal-agent-service.js";

export function mountPersonalAgentRoutes(app: Hono, deps: { personalAgent: PersonalAgentService }): void {
  const service = deps.personalAgent;
  app.get(API_ROUTES.agentPersonal, (c) => c.json({ agent: service.state() }));
  app.get(API_ROUTES.agentPersonalHandoffs, (c) => {
    // By id: the cards a transcript shows.
    const ids = (c.req.query("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    return c.json({ handoffs: service.handoffsByIds(ids) });
  });
  app.post(API_ROUTES.agentPersonalSeen, async (c) => {
    const body = await c.req.json().catch(() => null) as { seq?: unknown } | null;
    const result = service.markSeen(body?.seq);
    return "error" in result ? c.json(result, 400) : c.json({ agent: result });
  });
}
