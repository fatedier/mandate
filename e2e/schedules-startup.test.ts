import { afterAll, beforeAll, expect, test } from "bun:test";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ScheduleStore } from "../src/server/modules/schedules/schedule-store.js";
import { API_PATHS } from "../src/shared/api-contracts.js";
import type { ScheduleRunDto } from "../src/shared/api/schedules.js";
/** The schedule tick and the stagger after a start, short: the same order of
 *  runs as on 5 s each. */
const PACE = { scheduleTickMs: 200, scheduleBootStaggerMs: 200 };

/**
 * Schedules at start: one that came due while the server was down runs once
 * for every due time it missed; with schedules.enabled false in config.json,
 * nothing runs and the On duty page says schedules are off. Two servers on the
 * same seed, started together.
 */

const browser = browserForFile();
const DAY = 24 * 3_600_000;
let running: RunningServer;
let switchedOff: RunningServer;
/** When the switched-off server first answered: its scheduler had started. */
let offReadyAt = 0;
const seeded = { running: "", off: "" };

/** A duty thread whose daily check was last due two days ago. */
function seedOverdue(into: "running" | "off") {
  return (dataDir: string) => {
    const store = new MandateStore(dataDir);
    try {
      const agents = new AgentStore(store.db);
      const schedules = new ScheduleStore(store.db);
      const thread = agents.createManagerThread("greenhouse watch");
      const at = new Date(Date.now() - 3 * DAY).toISOString();
      const row = schedules.insert({
        threadId: thread.id, name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC",
        checkScript: `echo '{"wake":false}'`, checkTimeoutMs: 60_000, brief: "Watch the greenhouse.",
        status: "active", nextDueAt: new Date(Date.now() - 2 * DAY).toISOString()
      }, at);
      schedules.ensureDutyThread(thread.id, "investigate", `${dataDir}/notes`, at);
      seeded[into] = row.id;
    } finally {
      store.db.close();
    }
  };
}

beforeAll(async () => {
  [running, switchedOff] = await Promise.all([
    startServer({ configured: true, label: "schedules-startup-running", seed: seedOverdue("running"), runtime: PACE }),
    startServer({ configured: true, label: "schedules-startup-off", seed: seedOverdue("off"), config: { schedules: { enabled: false } }, runtime: PACE })
      .then((server) => { offReadyAt = Date.now(); return server; })
  ]);
}, 60_000);

afterAll(() => {
  running?.cleanup();
  switchedOff?.cleanup();
});

const runsOf = async (server: RunningServer, id: string) =>
  ((await (await fetch(`${server.baseUrl}${API_PATHS.scheduleRuns(id)}`)).json()) as { runs: ScheduleRunDto[] }).runs;
const overdueRun = () => waitUntil(async () => (await runsOf(running, seeded.running))[0] ?? null, { timeout: 20_000, label: "the overdue run" });

test("a restart runs a schedule that came due while it was down once, for every due time it missed", async () => {
  const run = await overdueRun();
  expect(run.outcome).toBe("quiet");
  expect(run.missed).toBeGreaterThanOrEqual(1);
  expect(await runsOf(running, seeded.running)).toHaveLength(1);
}, 30_000);

test("with the switch set, nothing runs and the On duty page says schedules are off", async () => {
  // Past when this server's own scheduler would have run its overdue check (a
  // tick and the stagger after it answered, and a second more), and past the
  // other server's run of the same check.
  const ranAt = Date.parse((await overdueRun()).startedAt);
  const by = Math.max(ranAt + PACE.scheduleTickMs, offReadyAt + PACE.scheduleTickMs + PACE.scheduleBootStaggerMs) + 1000;
  await waitUntil(() => Date.now() >= by || null, { timeout: 20_000, label: "past when the check would have run here" });
  expect(await runsOf(switchedOff, seeded.off)).toEqual([]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  attachPageDiagnostics(page);
  try {
    await page.goto(`${switchedOff.baseUrl}/duty`);
    await page.locator('[data-slot="duty-off"]').getByText("Schedules are off").waitFor({ timeout: 15_000 });
  } finally {
    await page.close();
  }
}, 40_000);
