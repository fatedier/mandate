import { act } from "react";
import { afterEach, expect, test } from "bun:test";
import { mount, settleUntil } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { dutySummaryDto, scheduleDto } from "../helpers/client-builders.js";
import { ScheduleChip } from "@/routes/threads/ScheduleChip";
import { dutyHomeLine, formatDue, scheduleChipText, scheduleRunText } from "@/lib/duty";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { API_PATHS } from "@shared/api-contracts";
import type { PersonalAgentDto } from "@shared/api/personal-agent";
import type { ScheduleRunDto } from "@shared/api/schedules";

afterEach(() => {
  runCleanups();
  usePersonalAgentStore.setState({ agent: null });
});

// The clock is the reader's: these are local times.
const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();
const NOW = local(11, 4, 8, 20);
const iso = (ms: number) => new Date(ms).toISOString();

test("a due time reads as its clock today, with its day after", () => {
  expect(formatDue(iso(local(11, 4, 9)), NOW)).toBe("09:00");
  expect(formatDue(iso(local(11, 7, 9)), NOW)).toBe("Nov 7 09:00");
});

test("the chip says when the thread is checked next, or that it is paused", () => {
  const due = (ms: number) => ({ nextDueAt: iso(ms) });
  expect(scheduleChipText(dutySummaryDto({ schedules: [scheduleDto("a", due(local(11, 7, 9)))] }), NOW)).toBe("Daily 09:00 · next Nov 7 09:00");
  // Several: the soonest of those that run.
  const several = [
    scheduleDto("a", due(local(11, 7, 9))),
    scheduleDto("b", { ...due(local(11, 4, 12)), cronText: "Hourly" }),
    scheduleDto("c", { ...due(local(11, 4, 10)), status: "paused" })
  ];
  expect(scheduleChipText(dutySummaryDto({ schedules: several }), NOW)).toBe("3 schedules · next 12:00");
  expect(scheduleChipText(dutySummaryDto({ schedules: [scheduleDto("a", { status: "paused", nextDueAt: null })] }), NOW)).toBe("Paused");
  // Switched off at the start: no check is coming, whatever is stored.
  expect(scheduleChipText(dutySummaryDto({ schedulesOff: true, schedules: [scheduleDto("a", due(local(11, 7, 9)))] }), NOW)).toBe("Schedules are off");
  expect(dutyHomeLine(dutySummaryDto({ schedulesOff: true, schedules: [scheduleDto("a", { ...due(local(11, 7, 9)), checksRun: 4 })] }), NOW)).toBe("Schedules are off");
});

const run = (outcome: ScheduleRunDto["outcome"], over: Partial<ScheduleRunDto> = {}): ScheduleRunDto =>
  ({ startedAt: iso(local(11, 4, 9)), outcome, line: "", missed: 0, durationMs: 40, ...over });

test("each check reads as what came of it", () => {
  expect([
    "quiet", "woke", "skipped_overlap", "skipped_floor", "test", "manual_quiet", "manual_woke"
  ].map((o) => scheduleRunText(run(o as ScheduleRunDto["outcome"])).outcome)).toEqual([
    "Nothing new", "Woke the thread", "Skipped: still running", "Skipped: too soon", "First run", "Run now · nothing new", "Run now · woke the thread"
  ]);
  expect(scheduleRunText(run("failed", { line: "exit code 2: curl: (7) Failed to connect" }))).toMatchObject({ outcome: "Failed", tone: "fail", line: "exit code 2: curl: (7) Failed to connect" });
  expect(scheduleRunText(run("woke", { missed: 2, line: '{"wake":true}' }))).toMatchObject({ tone: "ok", line: '2 missed, ran once · {"wake":true}' });
  expect(scheduleRunText(run("quiet")).tone).toBe("same");
});

const RUNS: ScheduleRunDto[] = [
  run("woke", { startedAt: iso(local(11, 4, 9)), line: '{"wake":true,"message":"2 new errors"}', missed: 2 }),
  run("quiet", { startedAt: iso(local(11, 3, 9)) }),
  run("failed", { startedAt: iso(local(11, 2, 9)), line: "exit code 7" })
];

function named(name: string) {
  act(() => usePersonalAgentStore.setState({ agent: { name, named: true } as PersonalAgentDto }));
}

function chip(duty = dutySummaryDto({ level: "fix_for_review" })) {
  const asked: string[] = [];
  mockFetch((call) => { asked.push(call.url); return jsonResponse({ runs: RUNS }); });
  named("Juno");
  const { host } = mount(<ScheduleChip duty={duty} />);
  return { host, asked, button: () => host.querySelector<HTMLButtonElement>('[data-slot="schedule-chip"]')! };
}

const card = () => document.querySelector<HTMLElement>('[data-slot="schedule-card"]');
const cardText = () => card()?.textContent ?? "";

test("pressing the chip reads the schedule's last checks and shows them, with no control to change anything", async () => {
  const s = chip();
  expect(s.button().textContent).toContain("Daily 09:00");
  expect(card() === null).toBe(true);
  await act(async () => { s.button().click(); });
  await settleUntil(() => cardText().includes("Woke the thread"), "the checks");
  expect(s.asked).toEqual([API_PATHS.scheduleRuns("sch_1")]);
  // A box at the chip, under its heading.
  expect(Boolean(card()!.closest('[data-slot="schedule-popover"]'))).toBe(true);
  expect(document.querySelector('[data-slot="schedule-popover"]')!.getAttribute("aria-label")).toBe("Schedule");
  for (const words of ["When", "Daily 09:00", "Level", "Fix for review", "Managed by", "Juno", "Checks", "Nothing new", "Failed", "exit code 7", "2 missed, ran once"]) {
    expect([words, cardText().includes(words)]).toEqual([words, true]);
  }
  expect(card()!.querySelector('[data-slot="schedule-card-ask"]')?.textContent).toBe("To change the schedule, ask Juno.");
  // Read only: nothing in it is a control.
  expect(card()!.querySelectorAll("button, input, select, textarea, a").length).toBe(0);
});

test("a paused schedule says why; the level reads in words", async () => {
  const s = chip(dutySummaryDto({ schedules: [scheduleDto("sch_1", { status: "paused", pausedReason: "its check failed 5 times in a row", nextDueAt: null })] }));
  expect(s.button().textContent).toBe("Paused");
  await act(async () => { s.button().click(); });
  await settleUntil(() => cardText().includes("Nothing new"), "the checks");
  expect(cardText()).toContain("Paused: its check failed 5 times in a row");
  expect(cardText()).toContain("Investigate and recommend");
});

test("at phone width the card is a sheet", async () => {
  onCleanup(fakePhoneWidth());
  const s = chip();
  await act(async () => { s.button().click(); });
  await settleUntil(() => cardText().includes("Woke the thread"), "the checks");
  expect(Boolean(card()!.closest('[data-slot="schedule-sheet"]'))).toBe(true);
  expect(document.querySelector('[data-slot="schedule-sheet"] h2, [data-slot="schedule-sheet"] [id]')?.textContent).toBe("Schedule");
  expect(card()!.querySelector('[data-slot="schedule-card-ask"]')?.textContent).toBe("To change the schedule, ask Juno.");
  expect(card()!.querySelectorAll("button, input, select, textarea, a").length).toBe(0);
  // Focusable, so a keyboard reaches what the half-raised sheet hides.
  expect(card()!.getAttribute("tabindex")).toBe("0");
});

test("a schedule kept in another zone names its zone beside its cron, as the card does: the next time is the reader's", () => {
  const reader = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const other = reader === "Pacific/Chatham" ? "Pacific/Kiritimati" : "Pacific/Chatham";
  const at = { nextDueAt: iso(local(11, 7, 9)) };
  expect(scheduleChipText(dutySummaryDto({ schedules: [scheduleDto("a", { ...at, timezone: other })] }), NOW)).toBe(`Daily 09:00 (${other}) · next Nov 7 09:00`);
  expect(scheduleChipText(dutySummaryDto({ schedules: [scheduleDto("a", { ...at, timezone: reader })] }), NOW)).toBe("Daily 09:00 · next Nov 7 09:00");
});
