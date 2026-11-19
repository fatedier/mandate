import { Cron } from "croner";

/** A schedule request Mandate will not take, with what is wrong; tools
 *  return its message to the agent. */
export class ScheduleRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleRefusal";
  }
}

function compile(cron: string, timezone: string): Cron {
  try {
    return new Cron(cron.trim(), { timezone, paused: true, mode: "5-part" });
  } catch (err) {
    throw new ScheduleRefusal(`not a 5-field cron expression (minute hour day-of-month month day-of-week): ${message(err)}`);
  }
}

/** The job's first due time strictly after `after`; null when it is never due again. */
function stepAfter(job: Cron, timezone: string, after: Date): Date | null {
  let probe = after;
  // In the hour the clocks repeat, croner can answer with the hour's first
  // pass, already behind `after`; asking again an hour on gets past it (that
  // hour's second pass is skipped, once a year).
  for (let tries = 0; tries < 48; tries++) {
    let next: Date | null;
    try {
      next = job.nextRun(probe);
    } catch (err) {
      throw new ScheduleRefusal(`not a time zone: ${timezone} (${message(err)})`);
    }
    if (!next) break;
    if (next.getTime() > after.getTime()) return next;
    probe = new Date(Math.max(probe.getTime(), next.getTime()) + HOUR_MS);
  }
  return null;
}

/** The first due time strictly after `after`: a standard 5-field cron in an
 *  IANA zone. Parsing and the calendar (DST included) are croner's. */
export function nextDue(cron: string, timezone: string, after: Date): Date {
  const next = stepAfter(compile(cron, timezone), timezone, after);
  if (!next) throw new ScheduleRefusal(`the cron "${cron}" is never due again`);
  return next;
}

/** The due times strictly after `after` and before `beforeMs`, in order, at
 *  most `max` of them: the cron parsed once, stepped as `nextDue` steps. */
export function dueTimesAfter(cron: string, timezone: string, after: Date, beforeMs: number, max: number): number[] {
  const job = compile(cron, timezone);
  const times: number[] = [];
  let probe = after;
  while (times.length < max) {
    const next = stepAfter(job, timezone, probe);
    if (!next || next.getTime() >= beforeMs) break;
    times.push(next.getTime());
    probe = next;
  }
  return times;
}

const HOUR_MS = 3_600_000;

const INT = /^\d{1,2}$/;

/** The cron in words where it has one of a few common shapes; otherwise
 *  the expression itself. For display only. */
export function describeCron(cron: string): string {
  const trimmed = cron.trim().split(/\s+/);
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = trimmed;
  const raw = `cron ${trimmed.join(" ")}`;
  if (trimmed.length !== 5) return raw;
  const time = INT.test(minute) && INT.test(hour) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : null;
  if (dom === "*" && month === "*") {
    if (time && dow === "*") return `Daily ${time}`;
    if (time && dow === "1-5") return `Weekdays ${time}`;
    if (minute === "0" && hour === "*" && dow === "*") return "Hourly";
    const every = /^\*\/(\d+)$/.exec(minute);
    if (every && hour === "*" && dow === "*") return `Every ${every[1]} min`;
  }
  return raw;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
