import type { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { parseDurationMs } from "../../../../shared/duration-short.js";
import type { ScheduleDto } from "../../../../shared/api/schedules.js";
import type { CreateScheduleInput, ScheduleManager, UpdateScheduleInput } from "../schedule-manager.js";
import { listSchedulesParams, manageScheduleParams } from "./schedule-tools-schema.js";

// The tools' descriptions are fixed wording the model reads: change them deliberately.

export interface ScheduleToolsDeps {
  schedules: Pick<ScheduleManager, "create" | "update" | "pause" | "resume" | "runNow" | "delete" | "list">;
  threadTitle: (threadId: string) => string | null;
}

type Refused = { error: string };

/** The personal agent's tools for schedules: only it has them. One lists
 *  (read-only, so a side chat may use it); one does everything else. */
export function buildScheduleTools(deps: ScheduleToolsDeps): ToolDefinition[] {
  const manage: ToolDefinition<z.infer<typeof manageScheduleParams>, unknown> = {
    name: "manage_schedule",
    description: [
      "Create, change, pause, resume, run or delete a schedule. At each time its cron names, Mandate runs the check script without a model; only when the check says so does it wake the schedule's duty thread with what the check found. Only you create and change schedules; duty threads cannot.",
      "- create: give name, cron, check, brief and thread. It is saved at once and its check runs once right away in the background: what that first run finds is the starting point and wakes nothing, and its result reaches you as a note. If the first run fails, the schedule stays saved and runs at its times; fix the check with update. Give paused: true and a reason to save it without running anything until you resume it.",
      "- update: give id and only what changes. A new check takes over at once and runs at its next due time, or now with run_now; that run is an ordinary check, and if it fails you are told at once. The check's saved state is kept unless resetState is true; then its next run is a first run: what it finds is the starting point and wakes nothing.",
      "- pause: give id, or all: true for every schedule, and a reason. A paused schedule runs nothing; a check already running finishes.",
      "- resume: give id, or all: true for every paused schedule. Due times missed while it was paused are not run; the next one counts from now. A check that has not had its first run gets it now.",
      "- run_now: give id. Its check runs now, as if it were due; it wakes the duty thread only if the check says so.",
      "- delete: give id. The schedule goes with its check history. When it was the duty thread's last schedule, that thread becomes an ordinary thread again; its notes stay."
    ].join("\n"),
    parameters: manageScheduleParams,
    handler: async (input) => {
      const misplaced = misplacedField(input);
      if (misplaced) return { error: misplaced };
      switch (input.action) {
        case "create": {
          if (!given(input.name) || !given(input.cron) || !given(input.check) || !given(input.brief) || !input.thread) {
            return { error: "create needs name, cron, check, brief and thread" };
          }
          const newTitle = given(input.thread.newTitle);
          const threadId = given(input.thread.threadId);
          if (Boolean(newTitle) === Boolean(threadId)) return { error: "give exactly one of thread.newTitle and thread.threadId" };
          const timeout = timeoutOf(input.checkTimeout);
          if (typeof timeout === "object") return timeout;
          const reason = given(input.reason)?.trim();
          if (input.paused && !reason) return { error: "pause needs a reason" };
          const request: CreateScheduleInput = {
            name: input.name!, cron: input.cron!, check: input.check!, brief: input.brief!,
            ...(given(input.timezone) ? { timezone: input.timezone!.trim() } : {}),
            ...(input.level ? { level: input.level } : {}),
            ...(timeout !== undefined ? { checkTimeoutMs: timeout } : {}),
            ...(input.paused ? { pausedReason: reason! } : {}),
            thread: newTitle ? { newTitle } : { threadId: threadId! }
          };
          return deps.schedules.create(request);
        }
        case "update": {
          const id = given(input.id);
          if (!id) return { error: "give the schedule's id" };
          const timeout = timeoutOf(input.checkTimeout);
          if (typeof timeout === "object") return timeout;
          const patch: UpdateScheduleInput = {
            ...(given(input.name) ? { name: input.name! } : {}),
            ...(given(input.cron) ? { cron: input.cron! } : {}),
            ...(given(input.timezone) ? { timezone: input.timezone!.trim() } : {}),
            ...(given(input.check) ? { check: input.check! } : {}),
            ...(given(input.brief) ? { brief: input.brief! } : {}),
            ...(input.level ? { level: input.level } : {}),
            ...(timeout !== undefined ? { checkTimeoutMs: timeout } : {}),
            ...(input.resetState ? { resetState: true } : {})
          };
          return deps.schedules.update(id, patch);
        }
        case "pause": {
          const target = targetOf(input);
          if ("error" in target) return target;
          const reason = given(input.reason);
          return reason ? { schedules: deps.schedules.pause(target, reason) } : { error: "pause needs a reason" };
        }
        case "resume": {
          const target = targetOf(input);
          if ("error" in target) return target;
          const resumed = deps.schedules.resume(target);
          return Array.isArray(resumed) ? { schedules: resumed } : resumed;
        }
        case "run_now": {
          const id = given(input.id);
          return id ? deps.schedules.runNow(id) : { error: "give the schedule's id" };
        }
        case "delete": {
          const id = given(input.id);
          if (!id) return { error: "give the schedule's id" };
          return deps.schedules.delete(id) ? { deleted: true } : { error: `no such schedule: ${id}` };
        }
      }
    }
  };
  const list: ToolDefinition<z.infer<typeof listSchedulesParams>, { schedules: Array<Omit<ScheduleDto, "threadId"> & { threadId: string | null; threadTitle: string | null }> }> = {
    name: "list_schedules",
    description: "List the schedules: each one's status, when it is next due, its last outcome, failures in a row, and its duty thread.",
    parameters: listSchedulesParams,
    // One whose thread is not open yet (an older version's, at the start): none is named.
    handler: async () => ({ schedules: deps.schedules.list().map((s) => (s.threadId ? { ...s, threadTitle: deps.threadTitle(s.threadId) } : { ...s, threadId: null, threadTitle: null })) })
  };
  return [manage, list] as ToolDefinition[];
}

/** The fields the schedule's definition is made of: create and update take them. */
const DEFINITION_FIELDS = ["name", "cron", "timezone", "check", "checkTimeout", "brief", "level"] as const;

/** A field given to an action that does not take it. A blank one, false, or
 *  an empty thread is a model's way of giving nothing: not a field. */
function misplacedField(input: z.infer<typeof manageScheduleParams>): string | null {
  const { action } = input;
  if (input.all && action !== "pause" && action !== "resume") return "all goes only with pause or resume";
  if (input.thread && (given(input.thread.newTitle) || given(input.thread.threadId)) && action !== "create") return "thread goes only with create";
  if (input.resetState && action !== "update") return "resetState goes only with update";
  if (input.paused && action !== "create") return "paused goes only with create";
  if (action !== "create" && action !== "update") {
    const field = DEFINITION_FIELDS.find((name) => given(input[name] as string | undefined));
    if (field) return `${field} goes only with create or update`;
  }
  return null;
}

/** A model fills a field it has no value for with "": that is no value. */
function given(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function timeoutOf(raw: string | undefined): number | undefined | Refused {
  if (!given(raw)) return undefined;
  const ms = parseDurationMs(raw!);
  return ms === null ? { error: `checkTimeout: give a duration like "60s" or "5m", not "${raw}"` } : ms;
}

function targetOf(input: { id?: string | undefined; all?: boolean | undefined }): { id: string } | { all: true } | Refused {
  if (input.all) return { all: true };
  const id = given(input.id);
  return id ? { id } : { error: "give the schedule's id, or all: true" };
}
