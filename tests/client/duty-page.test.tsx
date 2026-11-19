import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast } from "sonner";
import { DutyPage } from "@/routes/duty/DutyPage";
import { OnDutyNavRow } from "@/shell/OnDutyNavRow";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useThreadStatusStore } from "@/store/thread-status";
import { API_PATHS } from "@shared/api-contracts";
import { formatDue } from "@/lib/duty";
import type { ManagerThreadDto } from "@shared/api/agents";
import type { ScheduleDto } from "@shared/api/schedules";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mount, settle } from "../helpers/mount.js";
import { dutySummaryDto, managerThreadDto, scheduleDto } from "../helpers/client-builders.js";

// The On duty page: every duty thread in the order it was made, its checks,
// and what the user may do from here.

afterEach(() => {
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false });
    usePersonalAgentStore.setState({ agent: null });
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
  });
});

const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const dutyThread = (id: string, title: string, createdAt: string, schedules: Partial<ScheduleDto>[], over: Partial<ManagerThreadDto> = {}, level: "investigate" | "fix_for_review" = "investigate") =>
  managerThreadDto(id, { title, createdAt, duty: dutySummaryDto({ level, schedules: schedules.map((s, i) => scheduleDto(`${id}_s${i}`, { threadId: id, nextDueAt: soon(2), ...s })) }), ...over });

function seed(threads: ManagerThreadDto[]) {
  act(() => {
    useManagerThreadsStore.getState().replaceAll(threads);
    usePersonalAgentStore.setState({ agent: { threadId: "thr_g", name: "Juno", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } as never });
  });
}

const three = () => [
  dutyThread("thr_c", "Seed stock watch", "2026-11-03T00:00:00.000Z", [{ name: "seed stock", cronText: "Every 2 h", briefLine: "Seed packets running low", lastOutcome: "quiet", status: "paused" }]),
  dutyThread("thr_a", "Greenhouse sensor watch", "2026-11-01T00:00:00.000Z", [{ name: "sensors", cronText: "Every 30 min", briefLine: "Odd readings from the bed sensors", lastOutcome: "quiet" }]),
  dutyThread("thr_b", "Compost bin", "2026-11-02T00:00:00.000Z", [{ name: "compost", cronText: "Hourly", briefLine: "Fill level of the compost bin", lastOutcome: "failed", consecutiveFailures: 3 }], {}, "fix_for_review")
];

function render(calls: Array<{ method: string; url: string }> = [], answer: (url: string, method: string) => Response = () => jsonResponse({ runs: [] })) {
  mockFetch((call) => { calls.push({ method: call.method, url: call.url }); return answer(call.url, call.method); });
  return mount(
    <MemoryRouter initialEntries={["/duty"]}>
      <Routes>
        <Route path="/duty" element={<><OnDutyNavRow current /><DutyPage /></>} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
  ).host;
}

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-slot="duty-row"]')];
const rowOf = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-slot="duty-row"][data-thread-id="${id}"]`)!;
/** A button by its name: its words, or its label when it is an icon. */
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name);
const chip = (host: HTMLElement, text: string) => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="duty-chip"]')].find((b) => b.textContent === text)!;
const chips = (host: HTMLElement) => [...host.querySelectorAll('[data-slot="duty-chip"]')].map((c) => c.textContent);
/** Opens a row's ⋯ and gives its items' words. */
async function menuOf(row: HTMLElement): Promise<HTMLElement[]> {
  await act(async () => {
    button(row, "More actions")!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}
function toasts(): string[] {
  const shown: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => { shown.push(String(message)); return ""; }) as typeof toast.error;
  onCleanup(() => { toast.error = original; });
  return shown;
}

test("the page lists every duty thread in the order it was made, in rows with no header: what it watches, its last check, next and schedule", () => {
  seed(three());
  const host = render();
  expect(host.querySelector("table") === null).toBe(true);
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_a", "thr_b", "thr_c"]);
  const b = rowOf(host, "thr_b").textContent ?? "";
  for (const part of ["Compost bin", "Fill level of the compost bin", "Hourly", "Failed ×3"]) expect(b).toContain(part);
  // Its failure in red, as a word, not a pill.
  expect(rowOf(host, "thr_b").querySelector('[data-slot="duty-outcome"]')!.className).toContain("text-destructive");
  expect(rowOf(host, "thr_a").textContent).toContain("Nothing new");
  expect(rowOf(host, "thr_c").textContent).toContain("Paused");
  // The title is the way into the thread.
  expect(rowOf(host, "thr_b").querySelector<HTMLAnchorElement>('a[data-slot="duty-title"]')!.getAttribute("href")).toBe("/threads/thr_b");
});

test("the filters count and filter: all, needs a look, paused; and the next check", () => {
  seed(three());
  const host = render();
  expect(chips(host)).toEqual(["All 3", "Needs a look 1", "Paused 1"]);
  // The soonest due time, in the reader's clock (its date too when it is tomorrow).
  const next = [...useManagerThreadsStore.getState().threads.values()].flatMap((t) => t.duty?.schedules ?? [])
    .filter((x) => x.status === "active" && x.nextDueAt).map((x) => x.nextDueAt!).sort()[0]!;
  expect(host.querySelector('[data-slot="duty-next"]')?.textContent).toBe(`Next check ${formatDue(next, Date.now())}`);
  act(() => { chip(host, "Needs a look 1").click(); });
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_b"]);
  act(() => { chip(host, "Paused 1").click(); });
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_c"]);
  act(() => { chip(host, "All 3").click(); });
  expect(rows(host)).toHaveLength(3);
});

test("a filter whose count drops to none goes, and the page shows all again", () => {
  const threads = three();
  seed(threads);
  const host = render();
  act(() => { chip(host, "Paused 1").click(); });
  act(() => { useManagerThreadsStore.getState().replaceAll(threads.filter((t) => t.id !== "thr_c")); });
  expect(chips(host)).toEqual(["All 2", "Needs a look 1"]);
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_a", "thr_b"]);
  // Back to All for good: one paused again later does not take the page back to Paused.
  act(() => { useManagerThreadsStore.getState().replaceAll(threads); });
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_a", "thr_b", "thr_c"]);
  expect(chip(host, "All 3").getAttribute("aria-pressed")).toBe("true");
});

test("a list too narrow for the columns (a narrow window beside the sidebar) gets the phone's rows", () => {
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.dataset.slot === "duty-list" ? ({ width: 520, height: 300, top: 0, left: 0, right: 520, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect) : original.call(this);
  };
  onCleanup(() => {
    if (own) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", own);
    else delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });
  seed(three());
  const host = render();
  expect(rowOf(host, "thr_a").querySelector('[data-slot="duty-meta"]')).not.toBeNull();
  expect(rowOf(host, "thr_a").querySelector('[data-slot="duty-last"]') === null).toBe(true);
});

test("the order holds when an outcome changes", () => {
  const threads = three();
  seed(threads);
  const host = render();
  const a = threads.find((t) => t.id === "thr_a")!;
  const run = (patch: Partial<ScheduleDto>) => act(() => {
    useManagerThreadsStore.getState().replaceAll(threads.map((t) => (t.id === "thr_a" ? { ...a, duty: { ...a.duty!, schedules: [{ ...a.duty!.schedules[0]!, ...patch }] } } : t)));
  });
  run({ running: true });
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_a", "thr_b", "thr_c"]);
  expect(rowOf(host, "thr_a").textContent).toContain("Running…");
  run({ running: false, lastOutcome: "woke" });
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_a", "thr_b", "thr_c"]);
  expect(rowOf(host, "thr_a").textContent).toContain("Woke the thread");
});

test("pressing a row (not its title) shows its schedules, their last checks and its level", async () => {
  seed(three());
  const calls: Array<{ method: string; url: string }> = [];
  const host = render(calls, (url) => url.endsWith("/runs")
    ? jsonResponse({ runs: [{ dueAt: soon(-1), startedAt: soon(-1), outcome: "failed", line: "the bin sensor did not answer", missed: 0, durationMs: 40 }] })
    : jsonResponse({}));
  act(() => { rowOf(host, "thr_b").click(); });
  await settle(10);
  const runs = host.querySelector<HTMLElement>('[data-slot="duty-runs"]')!;
  expect(runs.textContent).toContain("the bin sensor did not answer");
  expect(runs.textContent).toContain("Fix for review");
  expect(calls.some((c) => c.url.endsWith(API_PATHS.scheduleRuns("thr_b_s0")))).toBe(true);
  // Pressing the title opens the thread, not the checks.
  act(() => { rowOf(host, "thr_a").querySelector<HTMLAnchorElement>('a[data-slot="duty-title"]')!.click(); });
  await settle(5);
  expect(host.querySelectorAll('[data-slot="duty-runs"]')).toHaveLength(0);
});

test("an open row reads its checks again once a check has run", async () => {
  const threads = three();
  seed(threads);
  let line = "first check";
  const calls: Array<{ method: string; url: string }> = [];
  const host = render(calls, (url) => url.endsWith("/runs")
    ? jsonResponse({ runs: [{ dueAt: soon(-1), startedAt: soon(-1), outcome: "quiet", line, missed: 0, durationMs: 40 }] })
    : jsonResponse({}));
  act(() => { rowOf(host, "thr_a").click(); });
  await settle(10);
  expect(host.querySelector('[data-slot="duty-runs"]')!.textContent).toContain("first check");
  line = "the check just run";
  const a = threads.find((t) => t.id === "thr_a")!;
  act(() => {
    useManagerThreadsStore.getState().replaceAll(threads.map((t) => (t.id === "thr_a" ? { ...a, duty: { ...a.duty!, schedules: [{ ...a.duty!.schedules[0]!, lastRunAt: soon(0) }] } } : t)));
  });
  await settle(10);
  expect(host.querySelector('[data-slot="duty-runs"]')!.textContent).toContain("the check just run");
});

test("a row opens from the keyboard: its ▸ is a button named Checks that says whether it is open", async () => {
  seed(three());
  const host = render();
  const fold = rowOf(host, "thr_b").querySelector<HTMLButtonElement>('button[aria-label="Checks"]')!;
  expect([fold.getAttribute("aria-label"), fold.getAttribute("aria-expanded")]).toEqual(["Checks", "false"]);
  act(() => { fold.click(); });
  await settle(5);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[data-slot="duty-runs"]')).not.toBeNull();
});

test("Run now, Pause and Resume call their routes; a refusal toasts its fixed words", async () => {
  seed(three());
  const shown = toasts();
  const calls: Array<{ method: string; url: string }> = [];
  let refusal: { code: string; status: number } | null = null;
  const host = render(calls, () => (refusal ? jsonResponse({ error: "x", code: refusal.code }, refusal.status) : jsonResponse({ schedule: {} })));
  const press = async (id: string, name: string) => { await act(async () => { button(rowOf(host, id), name)!.click(); }); await settle(5); };
  await press("thr_a", "Run now");
  await press("thr_a", "Pause");
  await press("thr_c", "Resume");
  expect(calls.filter((c) => c.method === "POST").map((c) => c.url.replace(/^.*\/api/, "/api"))).toStrictEqual([
    API_PATHS.scheduleRun("thr_a_s0"), API_PATHS.schedulePause("thr_a_s0"), API_PATHS.scheduleResume("thr_c_s0")
  ]);
  for (const [code, status, id, name] of [["running", 409, "thr_a", "Run now"], ["paused", 409, "thr_a", "Run now"], ["archived", 409, "thr_c", "Resume"], ["missing", 404, "thr_a", "Pause"]] as const) {
    refusal = { code, status };
    await press(id, name);
  }
  expect(shown).toStrictEqual([
    "Could not run the check: one is running now.",
    "Could not run the check: it is paused.",
    "Could not resume it: its thread is archived.",
    "Could not pause it: x"
  ]);
});

test("a thread with several schedules acts per schedule", async () => {
  seed([dutyThread("thr_m", "greenhouse checks", "2026-11-01T00:00:00.000Z", [{ name: "moisture" }, { name: "light" }])]);
  const calls: Array<{ method: string; url: string }> = [];
  const host = render(calls);
  const row = rowOf(host, "thr_m");
  expect(row.textContent).toContain("2 schedules");
  expect(button(row, "Run now") === undefined).toBe(true);
  expect((await menuOf(row)).map((i) => i.textContent)).toEqual(["Show in sidebar", "Open"]);
  act(() => { document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  act(() => { row.click(); });
  await settle(10);
  const runs = host.querySelector<HTMLElement>('[data-slot="duty-runs"]')!;
  expect([...runs.querySelectorAll("button")].filter((b) => b.textContent === "Run now")).toHaveLength(2);
});

test("paused is not failing: it is not counted, and reads Paused", () => {
  seed([dutyThread("thr_p", "Rain gauge log", "2026-11-01T00:00:00.000Z", [{ status: "paused", consecutiveFailures: 5, lastOutcome: "failed" }])]);
  const host = render();
  expect(chips(host)).toEqual(["All 1", "Paused 1"]);
  expect(rowOf(host, "thr_p").textContent).toContain("Paused");
  expect(rowOf(host, "thr_p").textContent).not.toContain("Failed");
  // Said once: its last check says it, its next says nothing more.
  expect(rowOf(host, "thr_p").textContent!.split("Paused").length - 1).toBe(1);
});

test("on a phone a thread never checked yet says only when it checks next, with no dot before it", () => {
  onCleanup(fakePhoneWidth());
  seed([dutyThread("thr_n", "Nightly audit", "2026-11-01T00:00:00.000Z", [{ lastOutcome: null, lastRunAt: null }])]);
  const host = render();
  const meta = rowOf(host, "thr_n").querySelector('[data-slot="duty-meta"]')!.textContent!;
  expect(meta.startsWith("Next ")).toBe(true);
});

test("on a phone a paused thread says Paused once too", () => {
  onCleanup(fakePhoneWidth());
  seed([dutyThread("thr_p", "Rain gauge log", "2026-11-01T00:00:00.000Z", [{ status: "paused", lastOutcome: "quiet" }])]);
  const host = render();
  expect(rowOf(host, "thr_p").textContent!.split("Paused").length - 1).toBe(1);
});

test("Show in sidebar and Remove from sidebar", async () => {
  const t = dutyThread("thr_a", "Greenhouse sensor watch", "2026-11-01T00:00:00.000Z", [{}]);
  const there = dutyThread("thr_b", "Compost bin", "2026-11-02T00:00:00.000Z", [{}]);
  seed([t, { ...there, duty: { ...there.duty!, sidebarAddedAt: "2026-11-05T00:00:00.000Z" } }]);
  const calls: Array<{ method: string; url: string }> = [];
  const host = render(calls, () => jsonResponse({ ok: true }));
  await act(async () => { (await menuOf(rowOf(host, "thr_a"))).find((i) => i.textContent === "Show in sidebar")!.click(); });
  await act(async () => { (await menuOf(rowOf(host, "thr_b"))).find((i) => i.textContent === "Remove from sidebar")!.click(); });
  await settle(5);
  expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.replace(/^.*\/api/, "/api")}`)).toStrictEqual([
    `PUT ${API_PATHS.dutySidebar("thr_a")}`, `DELETE ${API_PATHS.dutySidebar("thr_b")}`
  ]);
});

test("no duty threads: the page says how one comes", () => {
  seed([managerThreadDto("thr_plain")]);
  const host = render();
  expect(host.querySelector('[data-slot="duty-empty"]')?.textContent).toBe("No duty threads yet. Ask Juno to watch something on a schedule.");
});

test("on a phone the same rows, with ⋯ always there and Run now and Pause in it; pressing a row shows its checks", async () => {
  onCleanup(fakePhoneWidth());
  seed(three());
  const calls: Array<{ method: string; url: string }> = [];
  const host = render(calls, () => jsonResponse({ schedule: {}, runs: [] }));
  const card = rowOf(host, "thr_a");
  expect(button(card, "Run now") === undefined).toBe(true);
  const items = await menuOf(card);
  expect(items.map((i) => i.textContent)).toEqual(["Checks", "Run now", "Pause", "Show in sidebar", "Open"]);
  await act(async () => { items[1]!.click(); });
  await settle(5);
  expect(calls.some((c) => c.method === "POST" && c.url.endsWith(API_PATHS.scheduleRun("thr_a_s0")))).toBe(true);
  act(() => { card.click(); });
  await settle(10);
  expect(host.querySelector('[data-slot="duty-runs"]')).not.toBeNull();
  // From the keyboard too: Checks in ⋯ closes and opens them.
  const checks = (await menuOf(card)).find((i) => i.textContent === "Checks")!;
  expect(checks.dataset.open).toBe("true");
  await act(async () => { checks.click(); });
  await settle(5);
  expect(host.querySelector('[data-slot="duty-runs"]') === null).toBe(true);
});

test("the nav entry counts only the duty threads whose check is failing, in red; a report to read or a thread on duty is no count", () => {
  seed(three());
  const host = render();
  const nav = host.querySelector<HTMLElement>('[data-slot="on-duty-nav"]')!;
  // One failing: the count pill, red, and it needs the user.
  expect(nav.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("1 item needs you");
  expect(nav.querySelector('[role="img"]')!.className).toContain("text-destructive");
  // A report the user has not opened in the thread went to the personal
  // agent, which is where they read it: no count, and no total of threads on duty.
  const reported = dutyThread("thr_a", "Greenhouse sensor watch", "2026-11-01T00:00:00.000Z", [{}]);
  act(() => { useManagerThreadsStore.getState().replaceAll([{ ...reported, seenSeq: 2, duty: { ...reported.duty!, reportedSeq: 5 } }]); });
  expect(nav.textContent).toBe("On duty");
  act(() => { useManagerThreadsStore.getState().replaceAll([managerThreadDto("thr_plain")]); });
  expect(nav.textContent).toBe("On duty");
});

test("collapsed, the nav entry's dot is for a failing check only", () => {
  seed(three());
  const host = mount(<MemoryRouter><TooltipProvider><OnDutyNavRow collapsed current={false} /></TooltipProvider></MemoryRouter>).host;
  const dot = () => host.querySelector<HTMLElement>('[data-slot="on-duty-nav"] [role="img"]');
  expect(dot()?.getAttribute("aria-label")).toBe("1 item needs you");
  expect(dot()!.className.split(/\s+/)).toContain("bg-destructive");
  const reported = dutyThread("thr_a", "Greenhouse sensor watch", "2026-11-01T00:00:00.000Z", [{}]);
  act(() => { useManagerThreadsStore.getState().replaceAll([{ ...reported, seenSeq: 2, duty: { ...reported.duty!, reportedSeq: 5 } }]); });
  expect(dot() === null).toBe(true);
});

test("with schedules off the page says so, no next check is shown, and nothing can be run, paused or resumed", async () => {
  const t = dutyThread("thr_a", "Greenhouse sensor watch", "2026-11-01T00:00:00.000Z", [{}]);
  const p = dutyThread("thr_p", "Rain gauge log", "2026-11-02T00:00:00.000Z", [{ status: "paused" }]);
  seed([{ ...t, duty: { ...t.duty!, schedulesOff: true } }, { ...p, duty: { ...p.duty!, schedulesOff: true } }]);
  const calls: Array<{ method: string; url: string }> = [];
  const host = render(calls);
  expect(host.querySelector('[data-slot="duty-off"]')?.textContent).toBe("Schedules are off");
  expect(host.querySelector('[data-slot="duty-next"]') === null).toBe(true);
  expect(rowOf(host, "thr_a").textContent).not.toContain(formatDue(t.duty!.schedules[0]!.nextDueAt!, Date.now()));
  const buttons = [button(rowOf(host, "thr_a"), "Run now")!, button(rowOf(host, "thr_a"), "Pause")!, button(rowOf(host, "thr_p"), "Resume")!];
  expect(buttons.map((b) => b.disabled)).toStrictEqual([true, true, true]);
  for (const b of buttons) {
    await act(async () => { b.click(); });
  }
  await settle(5);
  expect(calls.filter((c) => c.method === "POST")).toStrictEqual([]);
});

test("an open paused row says why without saying Paused twice", async () => {
  seed([
    dutyThread("thr_o", "Rain gauge log", "2026-11-01T00:00:00.000Z", [{ status: "paused", pausedReason: "Paused by the user on the On duty page" }]),
    dutyThread("thr_f", "Compost heap", "2026-11-02T00:00:00.000Z", [{ status: "paused", pausedReason: "check failing" }])
  ]);
  const host = render();
  act(() => { rowOf(host, "thr_o").click(); rowOf(host, "thr_f").click(); });
  await settle(10);
  const text = [...host.querySelectorAll('[data-slot="duty-runs"]')].map((r) => r.textContent ?? "");
  expect(text[0]).toContain("Paused by the user on the On duty page");
  expect(text[0]).not.toContain("Paused: Paused");
  expect(text[1]).toContain("Paused: check failing");
});

test("a schedule paused after its failures, then resumed, is neither paused nor failing", () => {
  const paused = dutyThread("thr_p", "Rain gauge log", "2026-11-01T00:00:00.000Z", [{ status: "paused", consecutiveFailures: 5, lastOutcome: "failed", pausedReason: "check failing" }]);
  seed([paused]);
  const host = render();
  expect(chips(host)).toEqual(["All 1", "Paused 1"]);
  act(() => {
    useManagerThreadsStore.getState().replaceAll([{ ...paused, duty: { ...paused.duty!, schedules: [{ ...paused.duty!.schedules[0]!, status: "active", consecutiveFailures: 0, pausedReason: null }] } }]);
  });
  expect(chips(host)).toEqual(["All 1"]);
  expect(rowOf(host, "thr_p").querySelector('[data-slot="duty-outcome"]')!.className).not.toContain("text-destructive");
});

test("a thread with several schedules needs a look when one of them fails, and its row speaks for the failing one", () => {
  seed([dutyThread("thr_m", "greenhouse checks", "2026-11-01T00:00:00.000Z", [{ name: "moisture", lastOutcome: "quiet" }, { name: "light", lastOutcome: "failed", consecutiveFailures: 3 }])]);
  const host = render();
  expect(chips(host)).toEqual(["All 1", "Needs a look 1"]);
  const outcome = rowOf(host, "thr_m").querySelector('[data-slot="duty-outcome"]')!;
  expect([outcome.textContent, outcome.className.includes("text-destructive")]).toEqual(["Failed ×3", true]);
});

test("a row's schedule kept in another zone names its zone, in the row and in its checks", async () => {
  const reader = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const other = reader === "Pacific/Chatham" ? "Pacific/Kiritimati" : "Pacific/Chatham";
  seed([dutyThread("thr_z", "Night shift", "2026-11-01T00:00:00.000Z", [{ cronText: "Daily 09:00", timezone: other }])]);
  const host = render([], () => jsonResponse({ runs: [] }));
  expect(rowOf(host, "thr_z").textContent).toContain(`Daily 09:00 (${other})`);
  act(() => { rowOf(host, "thr_z").click(); });
  await settle(5);
  expect(host.querySelector('[data-slot="duty-runs"]')!.textContent).toContain(`Daily 09:00 (${other})`);
});
