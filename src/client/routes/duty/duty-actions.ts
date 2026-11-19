import { toast } from "sonner";
import { apiPath } from "@/lib/api-base";
import { errorText } from "@shared/error-text";
import { API_PATHS } from "@shared/api-contracts";
import type { ScheduleActionCode } from "@shared/api/schedules";

export type ScheduleAction = "run" | "pause" | "resume";

const LEAD: Record<ScheduleAction, string> = {
  run: "Could not run the check",
  pause: "Could not pause it",
  resume: "Could not resume it"
};

/** The refusals the page says in its own words; any other says the server's. */
const WORDS: Partial<Record<ScheduleAction, Partial<Record<ScheduleActionCode, string>>>> = {
  run: { running: "one is running now.", paused: "it is paused." },
  resume: { archived: "its thread is archived." }
};

const PATH: Record<ScheduleAction, (id: string) => string> = {
  run: API_PATHS.scheduleRun,
  pause: API_PATHS.schedulePause,
  resume: API_PATHS.scheduleResume
};

/** The owner pauses, resumes or runs a schedule now. What changed comes back
 *  as the thread's row over the stream; a refusal is a toast. */
export async function scheduleAction(action: ScheduleAction, scheduleId: string): Promise<boolean> {
  try {
    const res = await fetch(apiPath(PATH[action](scheduleId)), { method: "POST" });
    if (res.ok) return true;
    const body = (await res.json().catch(() => null)) as { error?: string; code?: ScheduleActionCode } | null;
    const words = body?.code ? WORDS[action]?.[body.code] : undefined;
    toast.error(`${LEAD[action]}: ${words ?? body?.error ?? `HTTP ${res.status}`}`);
  } catch (err) {
    toast.error(`${LEAD[action]}: ${errorText(err)}`);
  }
  return false;
}

/** A duty thread in or out of the owner's sidebar. A failed write leaves
 *  the button as it was: the row, not this call, says where it is. */
export async function setInSidebar(threadId: string, inSidebar: boolean): Promise<void> {
  await fetch(apiPath(API_PATHS.dutySidebar(threadId)), { method: inSidebar ? "PUT" : "DELETE" }).catch(() => {});
}
