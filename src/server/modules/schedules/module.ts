import type { MandateModule } from "../module.js";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { ScheduleActionError, ScheduleRunsResponse } from "../../../shared/api/schedules.js";
import { initializeSchedulesSchema } from "./schema.js";

/** How many of a schedule's checks its chip shows. */
const RUNS_SHOWN = 10;

export const schedulesModule: MandateModule = {
  id: "schedules",
  schema: [initializeSchedulesSchema],
  // The user changes a schedule by asking the personal agent; on the On duty page
  // they may only pause, resume or run one now, and put a duty thread in
  // or out of their sidebar.
  mountRoutes: (app, { deps }) => {
    const schedules = deps.schedules;
    if (!schedules) return;
    const refused = (r: ScheduleActionError) => (r.code === "missing" ? 404 : 409) as 404 | 409;
    app.get(API_ROUTES.scheduleRuns, (c) => c.json({ runs: schedules.runs(c.req.param("id"), RUNS_SHOWN) } satisfies ScheduleRunsResponse));
    app.post(API_ROUTES.schedulePause, (c) => {
      const r = schedules.ownerPause(c.req.param("id"));
      return "error" in r ? c.json(r, refused(r)) : c.json(r);
    });
    app.post(API_ROUTES.scheduleResume, (c) => {
      const r = schedules.ownerResume(c.req.param("id"));
      return "error" in r ? c.json(r, refused(r)) : c.json(r);
    });
    app.post(API_ROUTES.scheduleRun, async (c) => {
      const r = await schedules.ownerRunNow(c.req.param("id"));
      if ("error" in r) return c.json(r, refused(r));
      return "status" in r ? c.json(r, 202) : c.json(r);
    });
    app.put(API_ROUTES.dutySidebar, (c) => (schedules.addToSidebar(c.req.param("threadId")) ? c.json({ ok: true }) : c.json({ error: "not a duty thread" }, 404)));
    app.delete(API_ROUTES.dutySidebar, (c) => (schedules.removeFromSidebar(c.req.param("threadId")) ? c.json({ ok: true }) : c.json({ error: "not a duty thread" }, 404)));
  }
};
