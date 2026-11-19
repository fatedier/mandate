import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import type { DutyLevel } from "../../../shared/api/schedules.js";
import { readNotesIndex, renderNotesIndex } from "../personal/personal-context.js";
import { describeCron } from "./cron.js";
import type { ScheduleStore } from "./schedule-store.js";
import dutyContextTemplatePath from "./prompts/duty-runtime-context.md" with { type: "file" };

// Fixed wording the model reads: change it deliberately.
const LEVEL_TEXT: Record<DutyLevel, string> = {
  investigate: "investigate and recommend. Change no code unless the user's own words, quoted to you or said in this thread, ask for it. Deploying is never yours.",
  fix_for_review: "fix for review. Workers may fix what you find and open a branch or PR; report it for the user to review. Deploying is never yours."
};

export interface DutyContextInput {
  briefs: Array<{ name: string; cronText: string; brief: string }>;
  level: DutyLevel;
  notesDir: string;
  notesIndex: string | null;
  agentName: string;
}

/** A duty thread's block of its runtime context, shown on every wake. */
export function buildDutyContext(input: DutyContextInput): string {
  return renderPromptFile(dutyContextTemplatePath, {
    briefs: input.briefs.map((b) => `Schedule "${b.name}" (${b.cronText}):\n${b.brief}`).join("\n\n"),
    level: LEVEL_TEXT[input.level],
    notesDir: input.notesDir,
    notesIndex: renderNotesIndex(input.notesIndex),
    agentName: input.agentName
  });
}

/** What the manager scope asks about a thread: is it on duty, and its block. */
export interface DutyThreads {
  isDutyThread(threadId: string): boolean;
  context(threadId: string): string | null;
}

export function createDutyThreads(deps: { store: ScheduleStore; agentName: () => string }): DutyThreads {
  return {
    isDutyThread: (threadId) => deps.store.isDutyThread(threadId),
    context(threadId) {
      const schedules = deps.store.byThread(threadId);
      const duty = deps.store.dutyThread(threadId);
      if (schedules.length === 0 || !duty) return null;
      return buildDutyContext({
        briefs: schedules.map((s) => ({ name: s.name, cronText: describeCron(s.cron), brief: s.brief })),
        level: duty.level,
        notesDir: duty.notesDir,
        notesIndex: readNotesIndex(duty.notesDir),
        agentName: deps.agentName()
      });
    }
  };
}
