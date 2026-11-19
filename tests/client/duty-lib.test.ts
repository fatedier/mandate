import { expect, test } from "bun:test";
import { dutyMark, dutyNeedsLook, dutyOrder, scheduleOutcomeText } from "@/lib/duty";
import { dutySummaryDto, managerThreadDto, scheduleDto } from "../helpers/client-builders.js";
import type { ScheduleDto } from "@shared/api/schedules";

// Which duty threads need a look, and how each shows: one rule for the On
// duty page, its nav count, the sidebar and Home.

const duty = (schedules: Partial<ScheduleDto>[], over: { reportedSeq?: number | null; seenSeq?: number; createdAt?: string } = {}) =>
  managerThreadDto(`thr_${Math.random().toString(36).slice(2, 8)}`, {
    seenSeq: over.seenSeq ?? 0,
    createdAt: over.createdAt ?? "2026-11-01T00:00:00.000Z",
    duty: dutySummaryDto({ schedules: schedules.map((s, i) => scheduleDto(`sch_${i}`, s)), reportedSeq: over.reportedSeq ?? null })
  });

test("a duty thread needs a look when a report waits unread, or a check is failing", () => {
  expect(dutyNeedsLook(duty([{}]))).toBe(false);
  // A report the owner has not read; once read, no more.
  expect(dutyNeedsLook(duty([{}], { reportedSeq: 7, seenSeq: 3 }))).toBe(true);
  expect(dutyNeedsLook(duty([{}], { reportedSeq: 7, seenSeq: 7 }))).toBe(false);
  // Failing, active: yes; paused (Resume zeroes it), no.
  expect(dutyNeedsLook(duty([{ consecutiveFailures: 2, lastOutcome: "failed" }]))).toBe(true);
  expect(dutyNeedsLook(duty([{ consecutiveFailures: 5, lastOutcome: "failed", status: "paused" }]))).toBe(false);
  // Any of several schedules.
  expect(dutyNeedsLook(duty([{}, { consecutiveFailures: 1 }]))).toBe(true);
  expect(dutyNeedsLook(managerThreadDto("thr_plain"))).toBe(false);
  // A row with no duty field at all (an older server's) is no duty thread.
  const bare = { ...managerThreadDto("thr_bare") } as Partial<ReturnType<typeof managerThreadDto>>;
  delete bare.duty;
  expect(dutyNeedsLook(bare as ReturnType<typeof managerThreadDto>)).toBe(false);
  expect(dutyOrder([bare as ReturnType<typeof managerThreadDto>])).toEqual([]);
});

test("a duty thread's mark: running, failing, a report to read, or none", () => {
  expect(dutyMark(duty([{ running: true }]), "idle")).toBe("working");
  expect(dutyMark(duty([{}]), "working")).toBe("working");
  expect(dutyMark(duty([{ consecutiveFailures: 1 }]), "idle")).toBe("failed");
  expect(dutyMark(duty([{}]), "failed")).toBe("failed");
  expect(dutyMark(duty([{}], { reportedSeq: 4, seenSeq: 1 }), "idle")).toBe("result");
  expect(dutyMark(duty([{ status: "paused" }]), "idle")).toBe("idle");
  expect(dutyMark(duty([{ lastOutcome: "quiet" }]), "idle")).toBe("idle");
  // A question to the owner, a decision, a wait on a monitor: the thread's own mark.
  expect(dutyMark(duty([{}]), "needs_you")).toBe("needs_you");
  expect(dutyMark(duty([{}]), "decision")).toBe("decision");
  expect(dutyMark(duty([{}]), "watching")).toBe("watching");
  // A result to read comes from a report sent, never from the thread's dot alone.
  expect(dutyMark(duty([{}]), "result")).toBe("idle");
  // Running wins over the rest.
  expect(dutyMark(duty([{ running: true, consecutiveFailures: 2 }], { reportedSeq: 4 }), "idle")).toBe("working");
});

test("a schedule's last check reads in the schedule card's words", () => {
  expect(scheduleOutcomeText(scheduleDto("s", { running: true, lastOutcome: "quiet" }))).toBe("Running…");
  expect(scheduleOutcomeText(scheduleDto("s", { status: "paused", lastOutcome: "failed", consecutiveFailures: 5 }))).toBe("Paused");
  expect(scheduleOutcomeText(scheduleDto("s", { lastOutcome: "failed", consecutiveFailures: 3 }))).toBe("Failed ×3");
  expect(scheduleOutcomeText(scheduleDto("s", { lastOutcome: "failed", consecutiveFailures: 1 }))).toBe("Failed");
  expect(scheduleOutcomeText(scheduleDto("s", { lastOutcome: "quiet" }))).toBe("Nothing new");
  expect(scheduleOutcomeText(scheduleDto("s", { lastOutcome: "manual_woke" }))).toBe("Run now · woke the thread");
  expect(scheduleOutcomeText(scheduleDto("s", { lastOutcome: null }))).toBe("");
});

test("duty threads keep the order they were made in", () => {
  const a = duty([{}], { createdAt: "2026-11-03T00:00:00.000Z" });
  const b = duty([{}], { createdAt: "2026-11-01T00:00:00.000Z" });
  const c = duty([{ running: true }], { createdAt: "2026-11-02T00:00:00.000Z" });
  expect(dutyOrder([a, b, c, managerThreadDto("thr_plain")]).map((t) => t.id)).toEqual([b.id, c.id, a.id]);
});
