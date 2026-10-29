import { expect, test } from "bun:test";
import { foldWaitingLines, waitingLines } from "@/routes/window/chat/waiting-lines";
import { NO_NAMES } from "@/routes/window/chat/tool-details/names";
import type { AgentPendingMonitorDto } from "@shared/api-contracts";

// The waiting line: what the agent waits on, as the transcript
// names it; when that wakes it; until when; and its note. (Tests run in UTC.)

const NOW = Date.parse("2026-10-08T12:52:00.000Z");
const WATCH: AgentPendingMonitorDto = {
  kind: "pane", id: "ww_1", windowKey: "md-project-1:pr_48", paneId: "%103", stableMs: 45_000,
  timeoutAt: "2026-10-08T13:21:00.000Z", note: "read the review", createdAt: "2026-10-08T12:51:00.000Z"
};
const MONITOR: AgentPendingMonitorDto = {
  kind: "command", id: "mon_1", command: "gh pr checks 48 --json state", description: "project-1 CI on PR 48", everyMs: 300_000,
  wakeWhen: "succeeds", timeoutAt: "2026-10-09T14:00:00.000Z", note: "report the CI result", createdAt: "2026-10-08T12:40:00.000Z",
  runCount: 0, lastRunAt: null, nextRunAt: "2026-10-08T12:45:00.000Z", recentRuns: []
};
const SUBAGENT: AgentPendingMonitorDto = {
  kind: "subagent", id: "task_1", title: "project-1 0.72 release notes", status: "running", createdAt: "2026-10-08T12:45:00.000Z"
};
const BACKGROUND_COMMAND: AgentPendingMonitorDto = {
  kind: "background-command", id: "task_2", title: "Run the e2e suite", status: "running", createdAt: "2026-10-08T12:46:00.000Z"
};
const named = { ...NO_NAMES, watchPanes: new Map([["ww_1", "Codex PR48"]]) };

test("a pane watch reads by the name its pane had when it was registered, with when it wakes and until when", () => {
  expect(waitingLines([WATCH], named, NOW)).toEqual([{
    id: "ww_1", kind: "pane", lead: "Watching", label: "Codex PR48", mono: false,
    detail: "wakes after 45s of quiet · until 13:21", brief: "45s quiet · until 13:21", note: "read the review",
    at: Date.parse("2026-10-08T12:51:00.000Z")
  }]);
});

test("a pane the transcript never named reads as its id", () => {
  expect(waitingLines([WATCH], NO_NAMES, NOW)[0]).toMatchObject({ label: "%103", mono: true });
});

// The server's record of the name at registration comes first: the transcript
// knows it only when the call that named the pane is loaded.
test("a pane watch reads by the name the server recorded at registration, before the transcript's", () => {
  const recorded = { ...WATCH, paneName: "Codex PR56" };
  expect(waitingLines([recorded], NO_NAMES, NOW)[0]).toMatchObject({ label: "Codex PR56", mono: false });
  expect(waitingLines([recorded], named, NOW)[0]).toMatchObject({ label: "Codex PR56", mono: false });
});

test("a command monitor reads by its description, else its command; how often it runs, what wakes it, and a deadline on another day with its date", () => {
  expect(waitingLines([MONITOR], NO_NAMES, NOW)).toEqual([{
    id: "mon_1", kind: "command", lead: "Monitoring", label: "project-1 CI on PR 48", mono: false,
    detail: "every 5m · wakes when it succeeds · until Oct 9 · 14:00", brief: "every 5m · until Oct 9 · 14:00", note: "report the CI result",
    at: Date.parse("2026-10-08T12:40:00.000Z"),
    // Its card: not run yet, so no runs; when it runs next; its command.
    details: {
      meta: ["Not run yet", "next 12:45", "every 5m · until Oct 9 · 14:00"],
      note: "report the CI result",
      blocks: [{ label: "Command", text: "gh pr checks 48 --json state" }]
    }
  }]);
  const bare = waitingLines([{ ...MONITOR, description: null, wakeWhen: "changed", everyMs: 3_600_000, timeoutAt: "2026-10-08T15:00:00.000Z" }], NO_NAMES, NOW)[0]!;
  expect(bare).toMatchObject({ label: "gh pr checks 48 --json state", mono: true, detail: "every 1h · wakes when its output changes · until 15:00", brief: "every 1h · until 15:00" });
});

// A subagent is waited on too, but the strip above the composer shows it.
test("a subagent the agent waits on draws no waiting line; the others keep theirs", () => {
  expect(waitingLines([WATCH, SUBAGENT, MONITOR], named, NOW).map((line) => line.id)).toEqual(["ww_1", "mon_1"]);
  expect(waitingLines([SUBAGENT], named, NOW)).toEqual([]);
});

// So is a command bash runs in the background.
test("a background command the agent waits on draws no waiting line either", () => {
  expect(waitingLines([WATCH, BACKGROUND_COMMAND, MONITOR], named, NOW).map((line) => line.id)).toEqual(["ww_1", "mon_1"]);
  expect(waitingLines([BACKGROUND_COMMAND], named, NOW)).toEqual([]);
});

// An alarm the agent set wakes it at its time: the line says when, with its note.
test("an alarm reads as when it wakes the agent, with its note; on another day with its date", () => {
  const alarm: AgentPendingMonitorDto = { kind: "alarm", id: "alm_1", fireAt: "2026-10-08T13:30:00.000Z", note: "check the deploy", createdAt: "2026-10-08T12:30:00.000Z" };
  expect(waitingLines([alarm], NO_NAMES, NOW)).toEqual([{
    id: "alm_1", kind: "alarm", lead: "Wakes at", label: "13:30", mono: false, detail: "", brief: "", note: "check the deploy",
    at: Date.parse("2026-10-08T13:30:00.000Z")
  }]);
  expect(waitingLines([{ ...alarm, fireAt: "2026-10-09T09:00:00.000Z" }], NO_NAMES, NOW)[0]).toMatchObject({ label: "Oct 9 · 09:00" });
  expect(waitingLines([WATCH, alarm, SUBAGENT], named, NOW).map((line) => line.id)).toEqual(["ww_1", "alm_1"]);
});

// Two or more waits fold into one line: the one it leads with, how many more,
// and the next alarm when the lead is not one. Opened, a row each: panes,
// then commands, each the latest set first; then alarms by when they wake.
test("several waits fold behind the latest pane, then the latest command, then the earliest alarm", () => {
  const alarm = (id: string, fireAt: string): AgentPendingMonitorDto => ({ kind: "alarm", id, fireAt, note: "", createdAt: "2026-10-08T12:00:00.000Z" });
  const pane = (id: string, createdAt: string): AgentPendingMonitorDto => ({ ...WATCH, id, createdAt });
  const command = (id: string, createdAt: string): AgentPendingMonitorDto => ({ ...MONITOR, id, createdAt });
  const lines = waitingLines([
    alarm("alm_late", "2026-10-08T16:30:00.000Z"),
    command("mon_new", "2026-10-08T12:50:00.000Z"),
    pane("ww_old", "2026-10-08T12:10:00.000Z"),
    alarm("alm_soon", "2026-10-08T14:00:00.000Z"),
    pane("ww_new", "2026-10-08T12:30:00.000Z"),
    command("mon_old", "2026-10-08T12:20:00.000Z")
  ], NO_NAMES, NOW);
  const fold = foldWaitingLines(lines)!;
  expect(fold.rows.map((line) => line.id)).toEqual(["ww_new", "ww_old", "mon_new", "mon_old", "alm_soon", "alm_late"]);
  expect(fold).toMatchObject({ lead: { id: "ww_new" }, more: 5, nextWake: "14:00" });
  // No pane: the latest command leads.
  expect(foldWaitingLines(lines.filter((line) => line.kind !== "pane"))).toMatchObject({ lead: { id: "mon_new" }, more: 3, nextWake: "14:00" });
  // Only alarms: the earliest leads, and it is the next wake itself.
  expect(foldWaitingLines(lines.filter((line) => line.kind === "alarm"))).toMatchObject({ lead: { id: "alm_soon" }, more: 1, nextWake: null });
  // No alarm: no next wake.
  expect(foldWaitingLines(lines.filter((line) => line.kind !== "alarm"))).toMatchObject({ lead: { id: "ww_new" }, more: 3, nextWake: null });
  expect(foldWaitingLines(lines.slice(0, 1))).toMatchObject({ lead: { id: "alm_late" }, more: 0, nextWake: null });
  expect(foldWaitingLines([])).toBeNull();
});

// The card behind a command monitor's line: how many times it ran, the last
// and next run, its last five runs, how each ended.
test("a command monitor's card counts its runs, gives the last and next, and lists the recent ones, how each ended", () => {
  const run = (at: string, over: Partial<{ exitCode: number | null; timedOut: boolean; changed: boolean; line: string }> = {}) =>
    ({ at, exitCode: 1, timedOut: false, changed: false, line: "", ...over });
  const succeeds = waitingLines([{
    ...MONITOR, runCount: 23, lastRunAt: "2026-10-08T12:50:00.000Z", nextRunAt: "2026-10-08T12:55:00.000Z",
    recentRuns: [
      run("2026-10-08T12:50:00.000Z", { line: "2 checks pending" }),
      run("2026-10-08T12:45:00.000Z", { exitCode: null, timedOut: true, line: "" }),
      run("2026-10-08T12:40:00.000Z", { exitCode: null, line: "command not found: gh" }),
      run("2026-10-07T23:58:00.000Z", { exitCode: 0, line: "all checks passed" })
    ]
  }], NO_NAMES, NOW)[0]!.details!;
  expect(succeeds.meta).toEqual(["Ran 23 times", "last 12:50", "next 12:55", "every 5m · until Oct 9 · 14:00"]);
  expect(succeeds.runs).toEqual({
    rows: [
      { at: "12:50", outcome: "exit 1", tone: "fail", line: "2 checks pending" },
      { at: "12:45", outcome: "timed out", tone: "fail", line: "" },
      { at: "12:40", outcome: "could not run", tone: "fail", line: "command not found: gh" },
      { at: "Oct 7 · 23:58", outcome: "exit 0", tone: "ok", line: "all checks passed" }
    ],
    earlier: 19
  });
  const changed = waitingLines([{
    ...MONITOR, wakeWhen: "changed", runCount: 1, lastRunAt: "2026-10-08T12:50:00.000Z", nextRunAt: "2026-10-08T12:55:00.000Z",
    recentRuns: [run("2026-10-08T12:50:00.000Z", { exitCode: 0, line: "3 comments" })]
  }, {
    ...MONITOR, id: "mon_2", wakeWhen: "changed", runCount: 3, lastRunAt: "2026-10-08T12:50:00.000Z",
    recentRuns: [run("2026-10-08T12:50:00.000Z", { exitCode: 0, changed: true, line: "4 comments" }), run("2026-10-08T12:45:00.000Z", { exitCode: 2, line: "rate limited" })]
  }], NO_NAMES, NOW).map((line) => line.details!);
  expect(changed[0]!.meta[0]).toBe("Ran 1 time");
  expect(changed[0]!.runs).toEqual({ rows: [{ at: "12:50", outcome: "no change", tone: "same", line: "3 comments" }], earlier: 0 });
  expect(changed[1]!.runs!.rows.map((row) => [row.outcome, row.tone])).toEqual([["changed", "ok"], ["exit 2", "fail"]]);
});

test("a pane watch and an alarm have no card", () => {
  const alarm: AgentPendingMonitorDto = { kind: "alarm", id: "alm_1", fireAt: "2026-10-08T13:30:00.000Z", note: "check the deploy", createdAt: "2026-10-08T12:30:00.000Z" };
  expect(waitingLines([WATCH, alarm], named, NOW).map((line) => line.details)).toEqual([undefined, undefined]);
});
