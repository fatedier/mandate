import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { Sidebar } from "@/shell/Sidebar";
import { OnDutyNavSection } from "@/shell/OnDutyNavSection";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadStatusStore } from "@/store/thread-status";
import { formatDue } from "@/lib/duty";
import type { ManagerThreadDto } from "@shared/api/agents";
import type { ThreadDot } from "@shared/thread-dot";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { dutySummaryDto, managerThreadDto, scheduleDto } from "../helpers/client-builders.js";

afterEach(() => {
  // Unmount before the stores the lists read are reset under them.
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
  });
});

const HOUR = 3_600_000;
// Later today, whenever the test runs; and three days on.
const soon = new Date(new Date().setHours(23, 59, 0, 0)).toISOString();
const later = new Date(Date.now() + 3 * 24 * HOUR).toISOString();

const thread = (id: string, patch: Partial<ManagerThreadDto> = {}) => managerThreadDto(id, { title: `Thread ${id}`, ...patch });
const duty = (nextDueAt: string | null, status: "active" | "paused" = "active", over: { off?: boolean; sidebarAddedAt?: string | null; running?: boolean; reportedSeq?: number | null } = {}) =>
  dutySummaryDto({
    schedulesOff: over.off ?? false, sidebarAddedAt: over.sidebarAddedAt ?? null, reportedSeq: over.reportedSeq ?? null,
    schedules: [scheduleDto("sch_1", { nextDueAt, status, running: over.running ?? false })]
  });

/** Duty threads D1 (due within the day, put in the sidebar second), D2 (paused, not put there), D3 (due in three days, put there first) and ordinary T. */
function threads(over: { off?: boolean; d1?: Parameters<typeof duty>[2] } = {}) {
  return [
    thread("T", { lastActivityAt: "2026-09-27T13:00:00.000Z" }),
    thread("D1", { lastActivityAt: "2026-09-27T12:00:00.000Z", duty: duty(soon, "active", { off: over.off, sidebarAddedAt: "2026-11-05T10:00:00.000Z", ...over.d1 }) }),
    thread("D2", { lastActivityAt: "2026-09-27T11:00:00.000Z", duty: duty(null, "paused", { off: over.off }) }),
    thread("D3", { lastActivityAt: "2026-09-27T08:00:00.000Z", duty: duty(later, "active", { off: over.off, sidebarAddedAt: "2026-11-05T09:00:00.000Z" }) })
  ];
}
function seed(over: Parameters<typeof threads>[0] = {}) {
  act(() => {
    useManagerThreadsStore.getState().replaceAll(threads(over));
    useThreadStatusStore.getState().replace({
      threads: (Object.entries({ T: "idle", D1: "idle", D2: "idle", D3: "needs_you" }) as Array<[string, ThreadDot]>).map(([threadId, state]) => ({ threadId, state })),
      waiting: []
    });
  });
}

const render = (node: React.ReactNode) => mount(<MemoryRouter initialEntries={["/projects"]}>{node}</MemoryRouter>).host;
const group = (host: HTMLElement, label: string) => host.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
const titles = (el: HTMLElement | null) => [...(el?.querySelectorAll("[data-thread-title]") ?? [])].map((r) => r.getAttribute("data-thread-title"));
const trailing = (el: HTMLElement | null) => [...(el?.querySelectorAll("[data-thread-title]") ?? [])].map((r) => r.querySelector('[data-slot="duty-next"]')?.textContent ?? null);
const marks = (el: HTMLElement | null) => [...(el?.querySelectorAll("[data-thread-title]") ?? [])].map((r) => r.querySelector("[data-mark]")?.getAttribute("data-mark") ?? null);

test("the sidebar lists only the duty threads put there, in the order they were put there, each with its next check", () => {
  seed();
  const host = render(<Sidebar />);
  const onDuty = group(host, "On duty");
  const ordinary = group(host, "Threads");
  expect(titles(onDuty)).toEqual(["Thread D3", "Thread D1"]);
  expect(trailing(onDuty)).toEqual([formatDue(later, Date.now(), { short: true }), formatDue(soon, Date.now(), { short: true })]);
  // Today the time; another day the day.
  expect(trailing(onDuty)[1]).toMatch(/^\d{2}:\d{2}$/);
  expect(trailing(onDuty)[0]).not.toMatch(/:/);
  // A duty thread is never under Threads, put in the sidebar or not.
  expect(titles(ordinary)).toEqual(["Thread T"]);
  // Above Threads, under its own header at the rows' size.
  expect(onDuty!.compareDocumentPosition(ordinary!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const header = onDuty!.previousElementSibling!;
  expect(header.textContent).toBe("On duty");
  expect(header.querySelector("span")!.className.split(/\s+/)).toContain("label-group");
});

test("the sidebar keeps its rows when outcomes change; only their marks follow", () => {
  seed();
  const host = render(<OnDutyNavSection />);
  // D3 asks the owner something: its own mark, as any thread's.
  expect(marks(group(host, "On duty"))).toEqual(["dot", null]);
  act(() => { useManagerThreadsStore.getState().replaceAll(threads({ d1: { running: true } })); });
  expect(titles(group(host, "On duty"))).toEqual(["Thread D3", "Thread D1"]);
  expect(marks(group(host, "On duty"))).toEqual(["dot", "pulse"]);
  act(() => { useManagerThreadsStore.getState().replaceAll(threads({ d1: { reportedSeq: 5 } })); });
  expect(titles(group(host, "On duty"))).toEqual(["Thread D3", "Thread D1"]);
  expect(marks(group(host, "On duty"))).toEqual(["dot", "dot"]);
});

test("with schedules switched off, no row promises a check", () => {
  seed({ off: true });
  const host = render(<OnDutyNavSection />);
  expect(titles(group(host, "On duty"))).toEqual(["Thread D3", "Thread D1"]);
  expect(trailing(group(host, "On duty"))).toEqual([null, null]);
});

test("none put there, no group; the page's entry stays", () => {
  act(() => useManagerThreadsStore.getState().replaceAll([thread("T"), thread("D2", { duty: duty(null, "paused") })]));
  const host = render(<Sidebar />);
  expect(Boolean(group(host, "On duty"))).toBe(false);
  expect(host.querySelector('[data-slot="on-duty-nav"]')?.textContent).toBe("On duty");
  expect(titles(group(host, "Threads"))).toEqual(["Thread T"]);
});
