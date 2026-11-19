import type { NotifyOutcome, NotifyRequest } from "../notifications/notification-service.js";
import type { LearnedSkill, LearnedSkillStore } from "./learned-skill-store.js";
import { unusedSkillsArchivedNotice } from "./learned-skill-notices.js";

/**
 * The 60-day rule, with no model, at most once a day: the day's first check
 * archives every learned skill that has had neither a use nor a change in 60
 * days (LearnedSkillStore.archiveUnused) and tells the owner in one notice.
 * A day the rule already archived in is done, a restart's checks included.
 * A notice that found no channel waits for a later check, joined by any
 * later day's batch.
 */
export function createUnusedSkillsRule(deps: {
  store: Pick<LearnedSkillStore, "archiveUnused" | "archivedByRuleSince">;
  notify: (request: NotifyRequest) => Promise<NotifyOutcome>;
  now?: () => Date;
}): { tick(): Promise<void> } {
  const now = () => deps.now?.() ?? new Date();
  let checkedDay: string | null = null;
  let waiting: Array<Pick<LearnedSkill, "id" | "name">> = [];
  let waitingDay = "";
  let sending = false;
  return {
    async tick() {
      const at = now();
      // The server's own calendar day.
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
      if (day !== checkedDay) {
        checkedDay = day;
        const dayStart = new Date(at.getFullYear(), at.getMonth(), at.getDate()).toISOString();
        if (!deps.store.archivedByRuleSince(dayStart)) {
          const archived = deps.store.archiveUnused();
          if (archived.length > 0) {
            waiting = [...waiting, ...archived];
            waitingDay = day;
          }
        }
      }
      if (waiting.length === 0 || sending) return;
      sending = true;
      try {
        const told = waiting;
        const outcome = await deps.notify(unusedSkillsArchivedNotice(told, waitingDay));
        if (outcome.notSent !== "no_channel") waiting = waiting.slice(told.length);
      } finally {
        sending = false;
      }
    }
  };
}
