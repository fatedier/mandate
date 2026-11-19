import { z } from "zod";

// Fixed wording the model reads: change it deliberately.

/** One tool with an action. Every field but the action is optional, and a
 *  blank counts as not given, `until` too (an end goes by adding the entry
 *  again): a model fills the fields it does not mean. */
export const calendarParams = z.object({
  action: z.enum(["add", "update", "remove", "read"]).describe("add, update, remove or read."),
  id: z.string().nullable().optional().describe("For update, remove, and read of one entry: the id add returned; your entries are in your runtime context."),
  title: z.string().nullable().optional().describe("One line the user sees on the calendar, in their language."),
  note: z.string().nullable().optional().describe("For you, when it is due: what to do then, written so you can act on it without this conversation."),
  at: z.string().nullable().optional().describe("Once: a relative duration like '30m', '2h', '3d', or an absolute ISO time with timezone like '2026-05-22T10:30:00+08:00'. From 1 minute to 1 year from now."),
  repeat: z.string().nullable().optional().describe('On a repeat: a standard 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1" for every Monday at 09:00. At most once an hour.'),
  timezone: z.string().nullable().optional().describe('IANA time zone for repeat, e.g. "America/New_York". Defaults to this machine\'s.'),
  until: z.string().nullable().optional().describe("With repeat, if it should end: the last day it may be due, as YYYY-MM-DD."),
  paused: z.boolean().nullable().optional().describe("Update only: true pauses a repeat, false resumes it."),
  skip: z.string().nullable().optional().describe("Update only: a day (YYYY-MM-DD) on which a repeat is not due this once."),
  from: z.string().nullable().optional().describe("Read without id: the first day, as YYYY-MM-DD. Defaults to today."),
  to: z.string().nullable().optional().describe("Read without id: the last day, as YYYY-MM-DD, at most 92 days after from. Defaults to 7 days after from.")
});
