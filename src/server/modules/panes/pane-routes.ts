import type { Hono } from "hono";
import {
  API_ROUTES,
  type PaneSplitDirection,
  type PaneSplitRequest
} from "../../../shared/api-contracts.js";
import { PaneService, type PaneServiceDeps } from "./pane-service.js";

export function mountPaneRoutes(app: Hono, deps: PaneServiceDeps): void {
  const panes = new PaneService(deps);

  app.get(API_ROUTES.paneById, (c) => {
    const paneId = c.req.param("paneId");
    const dto = panes.getPane(paneId);
    if (!dto) return c.json({ error: "pane not found" }, 404);
    return c.json(dto);
  });

  app.post(API_ROUTES.paneSplit, async (c) => {
    const paneId = c.req.param("paneId");
    let body: Partial<PaneSplitRequest> = {};
    try { body = await c.req.json() as Partial<PaneSplitRequest>; } catch { /* empty body ok */ }
    const direction: PaneSplitDirection = body.direction === "down" ? "down" : "right";
    try {
      return c.json(panes.splitPane(paneId, direction, {
        name: typeof body.name === "string" ? body.name : undefined,
        description: typeof body.description === "string" ? body.description : undefined
      }));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete(API_ROUTES.paneById, async (c) => {
    const paneId = c.req.param("paneId");
    try {
      return c.json(await panes.killPane(paneId));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
