import type { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { CALENDAR_LIMITS } from "../../../../shared/api/calendar.js";
import { CalendarRefusal, dayOf, dayStart, isDay, nextDay } from "../calendar-rules.js";
import type { CalendarChange, CalendarService } from "../calendar-service.js";
import { renderCalendarDaysRead, renderCalendarEntryRead, renderCalendarLine, type CalendarTextClock } from "../calendar-text.js";
import { calendarParams } from "./calendar-tools-schema.js";

// Fixed wording the model reads: change it deliberately.
const DESCRIPTION = [
  "Your calendar, shown to the user on their Calendar page: what is planned for a time, once or on a repeat — a reminder for the user, or work you do yourself then. When an entry is due you are woken with its note. Actions:",
  "- add: a new entry: title, note, and either at (once) or repeat. Returns its id.",
  "- update: change an entry; what you give replaces that field. paused and skip apply to a repeat.",
  "- remove: take an entry off the calendar.",
  "- read: with id, one entry in full: its note, its rule, and the last times it was due. Without id, what is due day by day from `from` to `to`, with what was delivered on days already past."
].join("\n");

const NO_ENTRY = "No calendar entry with that id.";
const BAD_RANGE = "to must be on or after from, and at most 92 days after it.";

/** A value the model gave, or undefined for a blank or null one. */
const given = (value: string | null | undefined): string | undefined => (value?.trim() ? value.trim() : undefined);

/** Whole days from one YYYY-MM-DD to another. */
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

export interface CalendarToolDeps {
  calendar: CalendarService;
  /** The agent's zone: what it reads times and days in. */
  timeZone: string;
  now?: () => number;
}

/** The personal agent's one tool for its calendar: no thread or worker has it. */
export function buildCalendarTools(deps: CalendarToolDeps): ToolDefinition[] {
  const calendar = deps.calendar;
  const clock = (): CalendarTextClock => ({ timeZone: deps.timeZone, now: deps.now?.() ?? Date.now() });

  const readDays = (fromText: string | undefined, toText: string | undefined): string => {
    const today = dayOf(clock().now, deps.timeZone);
    const from = fromText ?? today;
    if (!isDay(from) || (toText !== undefined && !isDay(toText))) throw new CalendarRefusal("Give days as YYYY-MM-DD.");
    let to = toText;
    if (to === undefined) {
      to = from;
      for (let i = 0; i < 7; i++) to = nextDay(to);
    }
    const span = daysBetween(from, to);
    if (span < 0 || span > CALENDAR_LIMITS.readDays) throw new CalendarRefusal(BAD_RANGE);
    const range = calendar.range(dayStart(from, deps.timeZone), dayStart(nextDay(to), deps.timeZone));
    return renderCalendarDaysRead(range.times, clock());
  };

  const tool: ToolDefinition<z.infer<typeof calendarParams>, unknown> = {
    name: "calendar",
    description: DESCRIPTION,
    parameters: calendarParams,
    handler: async (args) => {
      try {
        switch (args.action) {
          case "add": {
            const entry = calendar.add({
              title: given(args.title), note: given(args.note), at: given(args.at), repeat: given(args.repeat),
              timezone: given(args.timezone), until: given(args.until)
            });
            return renderCalendarLine(entry, clock());
          }
          case "update": {
            const id = given(args.id);
            if (!id) return { error: NO_ENTRY };
            const change: CalendarChange = {};
            for (const key of ["title", "note", "at", "repeat", "timezone", "until", "skip"] as const) {
              const value = given(args[key]);
              if (value !== undefined) change[key] = value;
            }
            if (typeof args.paused === "boolean") change.paused = args.paused;
            return renderCalendarLine(calendar.update(id, change), clock());
          }
          case "remove": {
            const id = given(args.id);
            if (!id) return { error: NO_ENTRY };
            return `Removed "${calendar.remove(id, "agent").title}".`;
          }
          case "read": {
            const id = given(args.id);
            if (!id) return readDays(given(args.from), given(args.to));
            return renderCalendarEntryRead(calendar.entry(id), calendar.skipsAhead(id), calendar.recentTimes(id), clock());
          }
        }
      } catch (err) {
        if (err instanceof CalendarRefusal) return { error: err.message };
        throw err;
      }
    }
  };
  return [tool as ToolDefinition];
}
