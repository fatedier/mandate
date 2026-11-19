import { z } from "zod";

// Fixed wording the model reads: change it deliberately.

const NAME = "Short name the user sees: the service and what is checked.";
const CRON = 'When it is due, as a standard 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 9 * * *" for every day at 09:00. A due time less than 1 minute after the last run is skipped.';
const TIMEZONE = 'IANA time zone for the cron, e.g. "America/New_York". Defaults to this machine\'s.';
const CHECK = 'The check, a bash script of at most 16 KB. It reads its previous state from the file named by $MANDATE_CHECK_STATE, and gets $MANDATE_DUE_AT and $MANDATE_LAST_RUN_AT. Its last line of output must be one JSON object: {"wake": true|false, "message"?: string, "state"?: object, "items"?: [{"id": string, "title"?: string, "version"?: string}]}. An item already delivered wakes nothing again unless its version changes. A non-zero exit, a timeout, or any other last line is a failed run. "state" is at most 16 KB and is kept only when a run succeeds: keep what has already been reported in "state" or "items", not in files the check writes itself, or a failed run loses it.';
const CHECK_TIMEOUT = 'How long one run may take: "60s" (the default) up to "10m".';
const BRIEF = "What the duty thread is for and how to act on what the check finds, written for that thread (at most 4000 characters). It is shown to the thread every time it wakes.";
const LEVEL = '"investigate" (the default): investigate and recommend, with no code changes unless the user\'s own words ask for them. "fix_for_review": workers may fix what is found and open a branch or PR for the user to review. Deploying is part of neither. The level applies to every schedule of the duty thread.';
const THREAD = '{"newTitle": "..."} opens a new duty thread with that title; {"threadId": "..."} adds the schedule to an existing duty thread.';

// "" is a model's way of giving no value: it means no level.
const level = z.enum(["investigate", "fix_for_review", ""]);

/** One tool does everything but listing: create and update share one set
 *  of fields, sent once (the handler says which action takes which). */
export const manageScheduleParams = z.object({
  action: z.enum(["create", "update", "pause", "resume", "run_now", "delete"]).describe("What to do: create, update, pause, resume, run_now or delete."),
  id: z.string().optional().describe("The schedule, for every action but create."),
  all: z.boolean().optional().describe("With pause or resume: every schedule instead of one."),
  paused: z.boolean().optional().describe("Create only: save it paused; nothing runs until you resume it. Give reason too."),
  reason: z.string().optional().describe("With pause, or with a paused create: why, in a few words; the user sees it."),
  name: z.string().optional().describe(NAME),
  cron: z.string().optional().describe(CRON),
  timezone: z.string().optional().describe(TIMEZONE),
  check: z.string().optional().describe(CHECK),
  checkTimeout: z.string().optional().describe(CHECK_TIMEOUT),
  brief: z.string().optional().describe(BRIEF),
  level: level.optional().describe(LEVEL),
  thread: z.object({
    newTitle: z.string().optional(),
    threadId: z.string().optional()
  }).optional().describe(`Create only: ${THREAD}`),
  resetState: z.boolean().optional().describe("Update only: start the check from an empty state, as if new.")
});

export const listSchedulesParams = z.object({});
