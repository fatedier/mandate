import type { MandateModule } from "../module.js";
import {
  API_ROUTES,
  type WindowInspectRequest,
  type WindowInspectResponse
} from "../../../shared/api-contracts.js";
import { isRecord } from "../../../shared/guards.js";
import { errorText } from "../../../shared/error-text.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";

export const analysisModule: MandateModule = {
  id: "analysis",
  mountRoutes: (app, { deps }) => {
    // POST /api/windows/inspect — force one immediate poll of this window.
    //
    // The window is not kept in a forced set for later polls: such a set
    // would grow with every window a user refreshes, each costing a full pane
    // capture per poll, and later polls capture worker windows anyway —
    // shouldCapturePane returns true for any window in monitorWindowKeys, and
    // every worker window is in there.
    app.post(API_ROUTES.windowInspect, async (c) => {
      const body = await readJsonBody(c);
      if (body === INVALID_JSON) return c.json({ ok: false, error: "invalid JSON" }, 400);
      const request = body as Partial<WindowInspectRequest>;
      if (!isRecord(request) || typeof request.windowId !== "string" || !request.windowId) {
        return c.json({ ok: false, error: "windowId is required" }, 400);
      }
      try {
        await deps.pollTmux({ forceWindowIds: [request.windowId] });
        const response = { ok: true, snapshot: deps.poller.getSnapshot() } satisfies WindowInspectResponse;
        return c.json(response);
      } catch (error: unknown) {
        const message = errorText(error);
        return c.json({ ok: false, error: message }, 500);
      }
    });
  }
};
