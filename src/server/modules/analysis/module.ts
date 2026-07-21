import type { MandateModule } from "../module.js";
import {
  API_ROUTES,
  type WindowInspectRequest,
  type WindowInspectResponse
} from "../../../shared/api-contracts.js";

export const analysisModule: MandateModule = {
  id: "analysis",
  mountRoutes: (app, { deps }) => {
    // POST /api/windows/inspect — force one immediate poll of this window.
    //
    // It used to also pin the window into the poller's forced set. That was
    // removed 2026-08-05: the set was add-only, so every window a user ever
    // refreshed stayed in it until the process restarted, and each one cost a
    // full pane capture on every subsequent poll. It also bought nothing for
    // the case it was reached from — shouldCapturePane already returns true for
    // any window in monitorWindowKeys, and every feature window is in there.
    app.post(API_ROUTES.windowInspect, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "invalid JSON" }, 400);
      }
      const request = body as Partial<WindowInspectRequest>;
      if (!isRecord(request) || typeof request.windowId !== "string" || !request.windowId) {
        return c.json({ ok: false, error: "windowId is required" }, 400);
      }
      try {
        await deps.pollTmux({ forceWindowIds: [request.windowId] });
        const response = { ok: true, snapshot: deps.poller.getSnapshot() } satisfies WindowInspectResponse;
        return c.json(response);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ ok: false, error: message }, 500);
      }
    });
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
