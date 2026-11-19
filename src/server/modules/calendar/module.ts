import type { Context } from "hono";
import type { MandateModule } from "../module.js";
import { initializeCalendarSchema } from "./schema.js";
import { CalendarRefusal } from "./calendar-rules.js";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import { CALENDAR_LIMITS, type CalendarDto, type CalendarEntryResponse } from "../../../shared/api/calendar.js";

/** A refusal is the caller's to read; anything else is ours. */
function answer(c: Context, run: () => Response): Response {
  try {
    return run();
  } catch (err) {
    if (err instanceof CalendarRefusal) return c.json({ error: err.message }, err.status);
    throw err;
  }
}

function epochMs(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const ms = Number(text);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** The personal agent's calendar: the page reads a range and pauses, resumes,
 *  skips or deletes; the agent writes through its tool, never through these. */
export const calendarModule: MandateModule = {
  id: "calendar",
  schema: [initializeCalendarSchema],
  mountRoutes: (app, { deps }) => {
    const calendar = deps.calendar;
    if (!calendar) return;
    app.get(API_ROUTES.calendar, (c) => {
      const from = epochMs(c.req.query("from"));
      const to = epochMs(c.req.query("to"));
      if (from === null || to === null || to <= from || to - from > CALENDAR_LIMITS.readDays * 86_400_000) {
        return c.json({ error: `from and to must be epoch ms, to after from and at most ${CALENDAR_LIMITS.readDays} days after it` }, 400);
      }
      return c.json(calendar.range(from, to) satisfies CalendarDto);
    });
    app.post(API_ROUTES.calendarPause, (c) => answer(c, () => c.json({ entry: calendar.pause(c.req.param("id"), "user") } satisfies CalendarEntryResponse)));
    app.post(API_ROUTES.calendarResume, (c) => answer(c, () => c.json({ entry: calendar.resume(c.req.param("id"), "user") } satisfies CalendarEntryResponse)));
    app.post(API_ROUTES.calendarSkip, async (c) => {
      const input = await c.req.json().catch(() => null) as { at?: unknown } | null;
      const at = input?.at;
      if (typeof at !== "number" || !Number.isSafeInteger(at)) return c.json({ error: "at must be the due time, in epoch ms" }, 400);
      return answer(c, () => c.json({ entry: calendar.skipTime(c.req.param("id"), at, "user") } satisfies CalendarEntryResponse));
    });
    app.delete(API_ROUTES.calendarEntry, (c) => answer(c, () => c.json({ entry: calendar.remove(c.req.param("id"), "user") } satisfies CalendarEntryResponse)));
  }
};
