import type { Hono } from "hono";
import {
  API_ROUTES,
  type PaneSplitDirection,
  type PaneSplitRequest
} from "../../../shared/api-contracts.js";
import { PaneService, type PaneServiceDeps } from "./pane-service.js";
import { errorText } from "../../../shared/error-text.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";
import { tmuxPanePid } from "../../platform/tmux/tmux.js";

export function mountPaneRoutes(app: Hono, deps: PaneServiceDeps): void {
  const panes = new PaneService(deps);

  app.get(API_ROUTES.paneById, async (c) => {
    const paneId = c.req.param("paneId");
    const dto = await panes.getPane(paneId);
    if (dto) return c.json(dto);
    // Not in the last poll: gone only when tmux says so. A listing that failed
    // for a moment leaves the poll empty, and a page that took that for a 404
    // would call a live pane closed.
    const pid = await tmuxPanePid(paneId, deps.tmuxClient).catch(() => undefined);
    if (pid === null) return c.json({ error: "pane not found" }, 404);
    return c.json({ error: "pane not read yet" }, 503);
  });

  app.post(API_ROUTES.paneSplit, async (c) => {
    const paneId = c.req.param("paneId");
    // A missing or broken body is an empty one here.
    const parsed = await readJsonBody(c);
    const body = (parsed === INVALID_JSON ? {} : parsed) as Partial<PaneSplitRequest>;
    const direction: PaneSplitDirection = body.direction === "down" ? "down" : "right";
    try {
      return c.json(await panes.splitPane(paneId, direction));
    } catch (err) {
      return c.json({ error: errorText(err) }, 500);
    }
  });

  app.delete(API_ROUTES.paneById, async (c) => {
    const paneId = c.req.param("paneId");
    try {
      return c.json(await panes.killPane(paneId));
    } catch (err) {
      return c.json({ error: errorText(err) }, 500);
    }
  });
}
