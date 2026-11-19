import { API_ROUTES, type AppInfoResponse } from "../../../shared/api-contracts.js";
import type { MandateModule } from "../module.js";

export const stateModule: MandateModule = {
  id: "state",
  mountRoutes: (app) => {
    // The settings restart flow's readiness check is a HEAD; a GET answers
    // the same, with a body.
    app.get(API_ROUTES.info, (c) => {
      c.header("Cache-Control", "no-store");
      // Hono dispatches HEAD through GET: no body, no serialization.
      if (c.req.method === "HEAD") return c.body(null, 200);
      return c.json({ ok: true } satisfies AppInfoResponse);
    });
  }
};
