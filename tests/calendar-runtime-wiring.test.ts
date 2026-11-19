import { expect, spyOn, test } from "bun:test";
import type { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { CalendarStore } from "../src/server/modules/calendar/calendar-store.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { waitUntil } from "./helpers/wait.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// The runtime, not the calendar alone: an entry come due goes through the
// personal agent's inbox. Its wake refused (another writer holding the
// database), the mail stays queued once and the agent's follow-up is tried
// again, woken for the calendar; built again before the agent read it, the
// runtime delivers it no second time.

test("an entry come due whose wake is refused is queued once, the personal agent is woken for it when tried again, and a restart delivers it no second time", async () => {
  const env = freshStoresEnv("md-calendar-runtime-");
  const now = Date.now();
  new CalendarStore(env.store.db).insert({
    id: "cal_reviewAAAAA", title: "Weekly review of the schedules", note: "Read every schedule's runs and leave a sticky note.",
    atMs: now - 10 * 60_000, cron: null, timezone: "UTC", untilDay: null, pausedAt: null, pausedBy: null, skips: [],
    nextDueMs: now - 10 * 60_000, createdAt: now - 86_400_000, updatedAt: now - 86_400_000, deletedAt: null, deletedBy: null
  });
  const personal = env.agentStore.getOrCreatePersonalThread();
  const calendarMail = () => (env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'calendar'").all(personal.id) as Array<{ content: string }>)
    .map((row) => (JSON.parse(row.content) as { text: string }).text.split("\n")[0]);
  const originalError = console.error;
  console.error = () => {};
  const create = spyOn(env.agentStore, "createWake").mockImplementationOnce(() => { throw new Error("database is locked"); });
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    runtime = testAgentRuntime(env);
    expect(create).toHaveBeenCalledTimes(1);
    expect(calendarMail()).toEqual([expect.stringContaining('"Weekly review of the schedules"')]);
    expect(env.agentStore.getLatestWakeForThread(personal.id)).toBe(null);
    const wake = await waitUntil(() => env.agentStore.getLatestWakeForThread(personal.id), { timeout: 3000, label: "a wake for the calendar's mail" });
    expect(wake.reason).toBe("calendar");
    runtime.dispose();
    runtime = testAgentRuntime(env);
    expect(calendarMail().length).toBe(1);
  } finally {
    create.mockRestore();
    console.error = originalError;
    runtime?.dispose();
    env.cleanup();
  }
});
