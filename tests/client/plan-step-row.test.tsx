import { expect, jest, setSystemTime, test } from "bun:test";
import { act } from "react";
import { PlanStepRow } from "@/routes/window/plan/PlanStepRow";
import type { NoteLinkContext } from "@/routes/window/plan/note-links";
import type { PlanStepDto } from "@shared/api/plans";
import { onCleanup } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { fakeClock } from "../helpers/fake-clock.js";

const ctx: NoteLinkContext = {
  paneHref: (id) => `/pane/${id}`, paneName: () => undefined, canvasTitle: () => undefined, webBase: null, maxStepId: 0
};

test("a running step's age keeps counting while nothing else renders", () => {
  fakeClock();
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const step: PlanStepDto = {
    id: 3, title: "run the soak test", status: "in_progress", note: null,
    createdAt: startedAt, startedAt, blockedAt: null, completedAt: null, updatedAt: startedAt
  };
  const container = mount(<ul><PlanStepRow step={step} ctx={ctx} /></ul>).host;
  const meta = () => container.querySelector('[data-slot="plan-step-meta"]')!.textContent;
  expect(meta()).toBe("started just now");
  act(() => { jest.advanceTimersByTime(5 * 60_000); });
  expect(meta()).toBe("started 5m ago");
});

test("a done step names the day it was done, with the year only when it is not this one", () => {
  setSystemTime(new Date("2026-10-08T12:00:00"));
  onCleanup(() => setSystemTime());
  const done = (completedAt: string): PlanStepDto => ({
    id: 1, title: "tag the release", status: "done", note: null,
    createdAt: completedAt, startedAt: completedAt, blockedAt: null, completedAt, updatedAt: completedAt
  });
  const meta = (completedAt: string) =>
    mount(<ul><PlanStepRow step={done(completedAt)} ctx={ctx} /></ul>).host.querySelector('[data-slot="plan-step-meta"]')!.textContent;
  expect(meta("2026-10-05T10:00:00")).toBe("Oct 5");
  expect(meta("2025-09-23T10:00:00")).toBe("Sep 23, 2025");
});

// The opened step's times read "Added Oct 9 · 04:29 · Started Oct 9 · 04:31":
// one dot between a date and its time and between two times, the day said
// three times, and one breakable line that a phone split as "Done Oct" /
// "9 · 04:47". One day is written once; times on different
// days each carry theirs; a time never breaks.
test("an opened step writes its day once when every time falls on it, and each time stays whole", () => {
  setSystemTime(new Date("2026-10-09T12:00:00"));
  onCleanup(() => setSystemTime());
  const step = (over: Partial<PlanStepDto>): PlanStepDto => ({
    id: 2, title: "ship the fix", status: "done", note: null,
    createdAt: "2026-10-09T04:29:00", startedAt: "2026-10-09T04:31:00", blockedAt: null,
    completedAt: "2026-10-09T04:47:00", updatedAt: "2026-10-09T04:47:00", ...over
  });
  const times = (s: PlanStepDto) => {
    const host = mount(<ul><PlanStepRow step={s} ctx={ctx} /></ul>).host;
    act(() => { host.querySelector("button")!.click(); });
    const parts = [...host.querySelectorAll('[data-slot="plan-step-times"] > span')];
    for (const part of parts) expect(part.className).toContain("whitespace-nowrap");
    return parts.map((part) => part.textContent);
  };
  expect(times(step({}))).toEqual(["Oct 9", "Added 04:29", "Started 04:31", "Done 04:47"]);
  expect(times(step({ createdAt: "2026-10-08T22:10:00", startedAt: null }))).toEqual(["Added Oct 8 · 22:10", "Done Oct 9 · 04:47"]);
});

// With many steps (a 16-step plan, say), finished work took
// most of the first screen: five done steps, each with two lines of dense
// note, and the step being worked on below them. A done or pending step is
// one row until opened; the step being worked on (or blocked) shows its note.
const row = (over: Partial<PlanStepDto>): PlanStepDto => ({
  id: 4, title: "measure the evict path on both sides of the project-2 storage", status: "done",
  note: "measured on main and on the branch; numbers in %133",
  createdAt: "2026-10-09T04:29:00", startedAt: "2026-10-09T04:31:00", blockedAt: null,
  completedAt: "2026-10-09T04:47:00", updatedAt: "2026-10-09T04:47:00", ...over
});
const titleOf = (host: HTMLElement) => host.querySelector("button span.text-sm")!.className.split(/\s+/);

// The whole matrix, every status closed and opened: the
// note hidden, clamped to four lines or whole; the title faint or in full
// weight, cut to a line only for a closed done step.
test("every status, closed and opened, shows its note and title as the matrix says", () => {
  type Want = { note: "none" | "clamped" | "whole"; title: { has: string[]; lacks: string[] } };
  const faint = (cut: boolean) => ({ has: ["text-muted-foreground", ...(cut ? ["truncate"] : [])], lacks: ["font-medium", ...(cut ? [] : ["truncate"])] });
  const full = { has: ["font-medium"], lacks: ["text-muted-foreground", "truncate"] };
  const matrix: Array<[PlanStepDto["status"], Want, Want]> = [
    ["done", { note: "none", title: faint(true) }, { note: "whole", title: faint(false) }],
    ["pending", { note: "none", title: faint(false) }, { note: "whole", title: faint(false) }],
    ["in_progress", { note: "clamped", title: full }, { note: "whole", title: full }],
    ["blocked", { note: "clamped", title: full }, { note: "whole", title: full }]
  ];
  const check = (host: HTMLElement, want: Want, label: string) => {
    const note = host.querySelector('[data-slot="plan-note"]');
    const seen = note === null ? "none" : note.className.split(/\s+/).includes("line-clamp-4") ? "clamped" : note.className.includes("line-clamp") ? "other clamp" : "whole";
    expect(`${label}: ${seen}`).toBe(`${label}: ${want.note}`);
    // A note that shows is the step's own text.
    if (note) expect(`${label}: ${note.textContent}`).toBe(`${label}: measured on main and on the branch; numbers in %133`);
    for (const cls of want.title.has) expect(`${label} title has ${cls}: ${titleOf(host).includes(cls)}`).toBe(`${label} title has ${cls}: true`);
    for (const cls of want.title.lacks) expect(`${label} title has ${cls}: ${titleOf(host).includes(cls)}`).toBe(`${label} title has ${cls}: false`);
  };
  for (const [status, closed, opened] of matrix) {
    const host = mount(<ul><PlanStepRow step={row({ status, completedAt: status === "done" ? "2026-10-09T04:47:00" : null, blockedAt: status === "blocked" ? "2026-10-09T05:00:00" : null })} ctx={ctx} /></ul>, { path: "/" }).host;
    check(host, closed, `${status} closed`);
    act(() => { host.querySelector("button")!.click(); });
    check(host, opened, `${status} opened`);
  }
});
