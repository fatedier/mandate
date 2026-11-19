import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { CalendarDto, CalendarEntryDto, CalendarTimeDto } from "@shared/api/calendar";
import { CalendarView } from "@/routes/calendar/CalendarView";
import { useCalendarStore } from "@/store/calendar";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { viewerZone } from "@/routes/calendar/calendar-dates";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settle, settleUntil } from "../helpers/mount.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";

// The Calendar page: Day, Week, Month and List of the agent's entries, Today
// and a step back or on, an entry's details, and pause, resume and delete.

const NOW = new Date(2026, 10, 13, 15, 40); // Fri 13 Nov 2026, local
const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month, day, hour, minute).getTime();

beforeEach(() => { setSystemTime(NOW); });
afterEach(() => {
  runCleanups();
  setSystemTime();
  try { window.localStorage.clear(); } catch { /* none */ }
  act(() => {
    useCalendarStore.setState({ stamp: 0 });
    usePersonalAgentStore.setState({ agent: null });
  });
});

function entry(id: string, over: Partial<CalendarEntryDto> = {}): CalendarEntryDto {
  return { id, title: id, note: `Note of ${id}`, once: null, repeat: null, paused: null, createdAt: local(9, 1, 0), updatedAt: local(9, 1, 0), next: null, ahead: true, ...over };
}
const repeat = (cron: string, words: string, timezone = viewerZone(), until: string | null = null) => ({ cron, timezone, until, words });
/** A zone that is not this machine's, wherever the tests run. */
const ELSEWHERE = viewerZone() === "America/New_York" ? "Asia/Tokyo" : "America/New_York";

/** Every Monday 09:00; once today 16:00; weekdays 09:30 paused; Monday 09:00 in New York; a past once on Tue 10 Nov. */
function world(): { entries: CalendarEntryDto[]; times: (from: number, to: number) => CalendarTimeDto[] } {
  const entries = [
    entry("cal_weekly", { title: "Weekly progress notes", repeat: repeat("0 9 * * 1", "Every Monday 09:00") }),
    entry("cal_once", { title: "Read two chapters before book club", once: { at: local(10, 13, 16) } }),
    entry("cal_paused", { title: "Nightly", repeat: repeat("30 9 * * 1-5", "Weekdays 09:30", viewerZone(), "2026-12-18"), paused: { by: "user", at: local(10, 12, 0) } }),
    entry("cal_ny", { title: "NY", repeat: repeat("0 9 * * 1", "Every Monday 09:00", ELSEWHERE) }),
    entry("cal_past", { title: "Supplier mail", once: { at: local(10, 10, 10) }, ahead: false })
  ];
  const times = (from: number, to: number) => {
    const out: CalendarTimeDto[] = [];
    for (let day = new Date(from); day.getTime() < to; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
      const [y, m, d, dow] = [day.getFullYear(), day.getMonth(), day.getDate(), day.getDay()];
      const add = (entryId: string, title: string, at: number, outcome: CalendarTimeDto["outcome"], repeating = true) =>
        out.push({ entryId, title, at, outcome, deliveredAt: outcome === "delivered" ? at : null, repeating });
      const past = (at: number) => at <= NOW.getTime();
      if (dow === 1) add("cal_weekly", "Weekly progress notes", new Date(y, m, d, 9).getTime(), past(new Date(y, m, d, 9).getTime()) ? "delivered" : "due");
      if (dow >= 1 && dow <= 5) add("cal_paused", "Nightly", new Date(y, m, d, 9, 30).getTime(), past(new Date(y, m, d, 9, 30).getTime()) && d < 12 ? "delivered" : "paused");
      if (dow === 1) add("cal_ny", "NY", new Date(y, m, d, 22).getTime(), past(new Date(y, m, d, 22).getTime()) ? "delivered" : "due");
      if (y === 2026 && m === 10 && d === 13) add("cal_once", "Read two chapters before book club", local(10, 13, 16), "due", false);
      if (y === 2026 && m === 10 && d === 10) add("cal_past", "Supplier mail", local(10, 10, 10), "delivered", false);
    }
    return out.sort((a, b) => a.at - b.at);
  };
  return { entries, times };
}

function render(place: "page" | "panel" = "page", data = world()) {
  const calls = mockFetch((call: FetchCall) => {
    if (call.method !== "GET") return jsonResponse({ entry: {} });
    const url = new URL(call.url, "http://x");
    const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to"));
    return jsonResponse({ entries: data.entries, times: data.times(from, to), from, to } satisfies CalendarDto);
  });
  act(() => { usePersonalAgentStore.setState({ agent: { threadId: "thr_g", name: "Juno", named: true } as never }); });
  const mounted = mount(<MemoryRouter initialEntries={["/calendar"]}><CalendarView place={place} /></MemoryRouter>);
  return { host: mounted.host, calls, unmount: mounted.unmount };
}

const title = (host: ParentNode) => host.querySelector('[data-slot="calendar-title"]')?.textContent ?? "";
const button = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const blocks = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-slot="calendar-block"]')];
const block = (host: ParentNode, id: string, at: number) => host.querySelector<HTMLElement>(`[data-slot="calendar-block"][data-entry="${id}"][data-at="${at}"]`);
const details = () => document.body.querySelector<HTMLElement>('[data-slot="calendar-details"]');
const gets = (calls: FetchCall[]) => calls.filter((c) => c.method === "GET").map((c) => { const u = new URL(c.url, "http://x"); return [Number(u.searchParams.get("from")), Number(u.searchParams.get("to"))]; });
const writes = (calls: FetchCall[]) => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);

async function click(el: HTMLElement | null | undefined) {
  expect(Boolean(el)).toBe(true);
  await act(async () => { el!.click(); });
}

async function loaded(host: ParentNode) {
  await settleUntil(() => host.querySelector('[data-slot="calendar-block"], [data-slot="calendar-list-row"], [data-slot="calendar-chip"], [data-slot="calendar-empty"], [data-slot="calendar-list"]') !== null, "the calendar's range arrived");
}

test("the page opens on Week: its days, one block per time at its day, past ones dimmed, paused ones striped, now in today's column", async () => {
  const { host, calls } = render();
  await loaded(host);
  expect(host.querySelector('[data-slot="calendar-view"]')?.getAttribute("data-view")).toBe("week");
  expect(title(host)).toBe("9 – 15 Nov 2026");
  expect(gets(calls)[0]).toEqual([local(10, 9, 0), local(10, 16, 0)]);
  expect([...host.querySelectorAll('[data-slot="calendar-day-head"]')].map((h) => h.textContent)).toEqual(["Mon9", "Tue10", "Wed11", "Thu12", "Fri13", "Sat14", "Sun15"]);
  expect(host.querySelector('[data-slot="calendar-day-head"][data-today]')?.textContent).toBe("Fri13");
  const monday = block(host, "cal_weekly", local(10, 9, 9));
  const today = block(host, "cal_once", local(10, 13, 16));
  expect([monday?.hasAttribute("data-past"), today?.hasAttribute("data-past")]).toEqual([true, false]);
  expect(block(host, "cal_paused", local(10, 13, 9, 30))?.hasAttribute("data-paused")).toBe(true);
  // On the page a block says its time, then its title.
  expect(today?.textContent).toBe("16:00Read two chapters before book club");
  const columns = [...host.querySelectorAll('[data-slot="calendar-day-column"]')];
  expect(columns.map((c) => c.querySelector('[data-slot="calendar-now"]') !== null)).toEqual([false, false, false, false, true, false, false]);
  expect(blocks(host).length).toBe(1 + 5 + 1 + 1 + 1);
});

test("in the panel a Week block says only its title", async () => {
  const { host } = render("panel");
  await loaded(host);
  expect(block(host, "cal_once", local(10, 13, 16))?.textContent).toBe("Read two chapters before book club");
});

test("Previous, Next and Today move the period; each view says its own", async () => {
  const { host, calls } = render();
  await loaded(host);
  await click(button(host, "Next"));
  expect(title(host)).toBe("16 – 22 Nov 2026");
  await click(button(host, "Next"));
  await click(button(host, "Next"));
  expect(title(host)).toBe("30 Nov – 6 Dec 2026");
  await click(button(host, "Today"));
  expect(title(host)).toBe("9 – 15 Nov 2026");
  await click(button(host, "Day"));
  expect(title(host)).toBe("Fri 13 Nov 2026");
  await click(button(host, "Previous"));
  expect(title(host)).toBe("Thu 12 Nov 2026");
  await click(button(host, "Today"));
  await click(button(host, "Month"));
  expect(title(host)).toBe("November 2026");
  await click(button(host, "List"));
  expect(title(host)).toBe("13 Nov – 12 Dec 2026");
  await settleUntil(() => gets(calls).some(([f, t]) => f === local(10, 13, 0) && t === local(11, 13, 0)), "the list's 30 days were asked for");
});

// As the common calendars: opened at the working morning, then where the
// user scrolled it, week after week and from Week to Day.
test("Day and Week open at 07:30, and keep where they were scrolled on Previous, Next and from one to the other", async () => {
  const { host } = render();
  await loaded(host);
  const grid = () => host.querySelector<HTMLElement>('[data-slot="calendar-grid-scroll"]')!;
  expect(grid().scrollTop).toBe(44 * 7.5);
  act(() => { grid().scrollTop = 600; });
  await click(button(host, "Next"));
  await settleUntil(() => title(host) === "16 – 22 Nov 2026", "the next week");
  expect(grid().scrollTop).toBe(600);
  await click(button(host, "Day"));
  await settleUntil(() => host.querySelector('[data-slot="calendar-view"]')?.getAttribute("data-view") === "day", "Day");
  expect(grid().scrollTop).toBe(600);
});

test("Day says each time's repeat in words, with its zone when it is not the viewer's", async () => {
  const { host } = render();
  await loaded(host);
  await click(button(host, "Previous"));
  await click(button(host, "Day"));
  // The anchor stays the week's day it was on: Fri 6 Nov. Go to Monday 9 Nov.
  await click(button(host, "Next"));
  await click(button(host, "Next"));
  await click(button(host, "Next"));
  expect(title(host)).toBe("Mon 9 Nov 2026");
  await settleUntil(() => block(host, "cal_ny", local(10, 9, 22)) !== null, "Monday's blocks");
  expect(block(host, "cal_ny", local(10, 9, 22))?.textContent).toBe(`22:00NY· Every Monday 09:00 (${ELSEWHERE})`);
  expect(block(host, "cal_weekly", local(10, 9, 9))?.textContent).toBe("09:00Weekly progress notes· Every Monday 09:00");
});

test("Month: up to three a day, then +N more; a day opens in Day", async () => {
  const crowded = world();
  const base = crowded.times;
  crowded.times = (from, to) => [...base(from, to), ...[10, 11, 12].map((h) => ({ entryId: "cal_once", title: `Extra ${h}`, at: local(10, 20, h), outcome: "due" as const, deliveredAt: null, repeating: false }))]
    .sort((a, b) => a.at - b.at);
  const { host } = render("page", crowded);
  await loaded(host);
  await click(button(host, "Month"));
  await settleUntil(() => host.querySelector('[data-slot="calendar-chip"]') !== null, "the month's chips");
  const friday20 = [...host.querySelectorAll<HTMLElement>('[data-slot="calendar-day-cell"]')].find((c) => c.querySelector("button")?.getAttribute("aria-label") === "Fri 20 Nov");
  expect(friday20?.querySelectorAll('[data-slot="calendar-chip"]').length).toBe(2);
  expect(friday20?.querySelector('[data-slot="calendar-more"]')?.textContent).toBe("+2 more");
  await click(friday20?.querySelector<HTMLElement>('[data-slot="calendar-more"]'));
  expect([host.querySelector('[data-slot="calendar-view"]')?.getAttribute("data-view"), title(host)]).toEqual(["day", "Fri 20 Nov 2026"]);
});

// "Only this one" deletes that time, as the common calendars do: it is not
// drawn in Day, Week or Month (List leaves it out too), passed or ahead.
test("a skipped time is drawn nowhere: Week and Month leave it out, passed or ahead", async () => {
  const skipping = world();
  const base = skipping.times;
  const skipped = new Set([local(10, 9, 9), local(10, 16, 9)]);
  skipping.times = (from, to) => base(from, to).map((t) => (t.entryId === "cal_weekly" && skipped.has(t.at) ? { ...t, outcome: "skipped" as const, deliveredAt: null } : t));
  const page = render("page", skipping);
  await loaded(page.host);
  expect(block(page.host, "cal_weekly", local(10, 9, 9))).toBe(null);
  await click(button(page.host, "Next"));
  await settleUntil(() => title(page.host) === "16 – 22 Nov 2026" && block(page.host, "cal_ny", local(10, 16, 22)) !== null, "the next week's blocks");
  expect(block(page.host, "cal_weekly", local(10, 16, 9))).toBe(null);
  await click(button(page.host, "Month"));
  await settleUntil(() => page.host.querySelector('[data-slot="calendar-chip"]') !== null, "the month's chips");
  const chips = [...page.host.querySelectorAll<HTMLElement>('[data-slot="calendar-chip"][data-entry="cal_weekly"]')].map((c) => Number(c.getAttribute("data-at")));
  expect(chips.filter((at) => skipped.has(at))).toEqual([]);
  expect(chips.includes(local(10, 23, 9))).toBe(true);
  page.unmount();
});

test("List leaves out past and paused times, and says when there is nothing", async () => {
  const { host } = render();
  await loaded(host);
  await click(button(host, "List"));
  await settleUntil(() => host.querySelector('[data-slot="calendar-list-row"]') !== null, "the list's rows");
  const rows = [...host.querySelectorAll<HTMLElement>('[data-slot="calendar-list-row"]')];
  expect(rows.some((r) => r.dataset.entry === "cal_paused")).toBe(false);
  expect(rows.some((r) => r.dataset.entry === "cal_past")).toBe(false);
  expect(rows[0]?.dataset.entry).toBe("cal_once");
  expect([...host.querySelectorAll('[data-slot="calendar-list-day"] h3')].slice(0, 2).map((h) => h.textContent)).toEqual(["Today", "Mon 16 Nov"]);
  await click(button(host, "Previous"));
  await settleUntil(() => host.textContent?.includes("Nothing in these days.") === true, "the past 30 days, nothing to deliver");
});

test("with no entries Day, Week and Month draw their grid, empty, as the common calendars do; only List says Nothing on the calendar.", async () => {
  const { host, calls } = render("page", { entries: [], times: () => [] });
  // Kept to text and counts: a failing compare would print a whole element.
  const empty = () => host.querySelector('[data-slot="calendar-empty"]')?.textContent ?? null;
  /** The range asked for has come, and been drawn. */
  const arrived = async (count: number) => {
    await settleUntil(() => gets(calls).length >= count, `range ${count} asked for`);
    await settle(20);
  };
  await arrived(1);
  expect([host.querySelectorAll('[data-slot="calendar-day-head"]').length, empty()]).toEqual([7, null]);
  // Week to Day: the grid stays a grid once the day's range has come (it
  // was drawn while it loaded, and is not taken away then).
  await click(button(host, "Day"));
  await arrived(2);
  expect([host.querySelectorAll('[data-slot="calendar-day-head"]').length, empty()]).toEqual([1, null]);
  await click(button(host, "Month"));
  await arrived(3);
  expect([host.querySelector('[data-slot="calendar-month"]') !== null, empty()]).toEqual([true, null]);
  await click(button(host, "List"));
  await arrived(4);
  expect(empty()).toBe("Nothing on the calendar.");
});

test("a block opens its details: the day and time, the repeat with Paused, the agent's note; Pause and Resume post", async () => {
  const { host, calls } = render();
  await loaded(host);
  await click(block(host, "cal_paused", local(10, 13, 9, 30)));
  const open = details();
  expect(open?.querySelector('[data-slot="calendar-details-title"]')?.textContent).toBe("Nightly");
  expect(open?.textContent?.includes("Fri 13 Nov · 09:30")).toBe(true);
  expect(open?.querySelector('[data-slot="calendar-details-repeat"]')?.textContent).toBe("Weekdays 09:30 · until 18 Dec");
  expect(open?.textContent?.includes("Paused")).toBe(true);
  expect(open?.textContent?.includes("Juno's note")).toBe(true);
  expect(open?.querySelector('[data-slot="calendar-details-note"]')?.textContent).toBe("Note of cal_paused");
  await click(button(open!, "Resume"));
  await click(button(details()!, "Close"));
  expect(details() === null).toBe(true);
  await click(block(host, "cal_weekly", local(10, 9, 9)));
  await click(button(details()!, "Pause"));
  await settleUntil(() => writes(calls).length === 2, "both writes went");
  expect(writes(calls)).toEqual(["POST /api/calendar/cal_paused/resume", "POST /api/calendar/cal_weekly/pause"]);
});

test("Delete asks first: a one-off can't be undone; a repeat's time ahead is skipped alone or all deleted; a past one only all", async () => {
  const { host, calls } = render();
  await loaded(host);
  await click(block(host, "cal_once", local(10, 13, 16)));
  await click(button(details()!, "Delete"));
  expect(details()?.querySelector('[data-slot="calendar-details-ask"] p')?.textContent).toBe(`Delete "Read two chapters before book club"? This can't be undone.`);
  await click(button(details()!, "Cancel"));
  await click(button(details()!, "Delete"));
  await click(button(details()!.querySelector('[data-slot="calendar-details-ask"]')!, "Delete"));
  expect(details() === null).toBe(true);
  await click(button(host, "Next"));
  await settleUntil(() => block(host, "cal_weekly", local(10, 16, 9)) !== null, "next week's Monday");
  await click(block(host, "cal_weekly", local(10, 16, 9)));
  await click(button(details()!, "Delete"));
  expect(details()?.querySelector('[data-slot="calendar-details-ask"] p')?.textContent).toBe(`Delete "Weekly progress notes"?`);
  await click(button(details()!, "Only this one"));
  await click(button(host, "Previous"));
  await settleUntil(() => block(host, "cal_weekly", local(10, 9, 9)) !== null, "this week's Monday");
  await click(block(host, "cal_weekly", local(10, 9, 9)));
  await click(button(details()!, "Delete"));
  expect([button(details()!, "Only this one") === undefined, button(details()!, "All of them") !== undefined]).toEqual([true, true]);
  await click(button(details()!, "All of them"));
  await settleUntil(() => writes(calls).length === 3, "the three writes went");
  expect(writes(calls)).toEqual(["DELETE /api/calendar/cal_once", "POST /api/calendar/cal_weekly/skip", "DELETE /api/calendar/cal_weekly"]);
  expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/skip"))!.init?.body))).toEqual({ at: local(10, 16, 9) });
});

test("a past one-off shows no Delete; Escape closes the details", async () => {
  const { host } = render();
  await loaded(host);
  await click(block(host, "cal_past", local(10, 10, 10)));
  expect([details() !== null, button(details()!, "Delete") === undefined]).toEqual([true, true]);
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settleUntil(() => details() === null, "Escape closed the details");
});

test("closed by Escape or Close, the details give the focus back to the time they were opened from; closed by a press elsewhere, not", async () => {
  const { host } = render();
  await loaded(host);
  const opener = block(host, "cal_past", local(10, 10, 10))!;
  const other = block(host, "cal_once", local(10, 13, 16))!;
  const escape = async () => { await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); };
  act(() => { opener.focus(); });
  await click(opener);
  await settleUntil(() => details() !== null, "the details opened");
  await escape();
  await settleUntil(() => details() === null, "Escape closed the details");
  await settleUntil(() => document.activeElement === opener, "Escape gave the focus back to the block");
  await click(opener);
  await settleUntil(() => details() !== null, "the details opened again");
  await click(button(details()!, "Close"));
  await settleUntil(() => details() === null, "Close closed the details");
  await settleUntil(() => document.activeElement === opener, "Close gave the focus back to the block");
  // A press on another block opens its details, and the first ones, closing,
  // leave the focus where that put it.
  await click(opener);
  await settleUntil(() => details() !== null, "the details opened a third time");
  // Radix listens for a press outside from the next task on, and closes on its click.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => {
    other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
    other.focus();
    other.click();
  });
  await settleUntil(() => details()?.querySelector('[data-slot="calendar-details-title"]')?.textContent === "Read two chapters before book club", "the press opened the other block's details");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(document.activeElement === opener).toBe(false);
});

test("each place remembers the view chosen in it", async () => {
  const first = render("page");
  await loaded(first.host);
  await click(button(first.host, "Month"));
  first.unmount();
  const again = render("page");
  await loaded(again.host);
  expect(again.host.querySelector('[data-slot="calendar-view"]')?.getAttribute("data-view")).toBe("month");
  again.unmount();
  const panel = render("panel");
  await loaded(panel.host);
  expect(panel.host.querySelector('[data-slot="calendar-view"]')?.getAttribute("data-view")).toBe("week");
});

test("on a phone: List first, details in a sheet from the bottom, Month as dots with the tapped day's times under it", async () => {
  onCleanup(fakePhoneWidth());
  const { host } = render("page");
  await settleUntil(() => host.querySelector('[data-slot="calendar-list-row"]') !== null, "the list's rows");
  expect(host.querySelector('[data-slot="calendar-view"]')?.getAttribute("data-place")).toBe("phone");
  expect(host.querySelector('[data-slot="calendar-view"]')?.getAttribute("data-view")).toBe("list");
  await click(host.querySelector<HTMLElement>('[data-slot="calendar-list-row"][data-entry="cal_once"]'));
  await settleUntil(() => details() !== null, "the sheet opened");
  expect(document.body.querySelector('[data-slot="calendar-details-popover"]') === null).toBe(true);
  await click(button(details()!, "Close"));
  await click(button(host, "Month"));
  await settleUntil(() => host.querySelector('[data-slot="calendar-dots"] i') !== null, "the month's dots");
  expect(host.querySelector('[data-slot="calendar-chip"]') === null).toBe(true);
  const monday16 = [...host.querySelectorAll<HTMLElement>('[data-slot="calendar-day-cell"]')].find((c) => c.getAttribute("aria-label") === "Mon 16 Nov");
  await click(monday16);
  const picked = host.querySelector('[data-slot="calendar-picked-day"]');
  expect(picked?.querySelector("h3")?.textContent).toBe("Mon 16 Nov");
  expect([...picked!.querySelectorAll<HTMLElement>('[data-slot="calendar-list-row"]')].map((r) => r.dataset.entry)).toEqual(["cal_weekly", "cal_paused", "cal_ny"]);
});

test("on a phone the tapped day's times under the Month are dimmed when past and marked when paused, as the grid's are", async () => {
  onCleanup(fakePhoneWidth());
  const { host } = render("page");
  await settleUntil(() => host.querySelector('[data-slot="calendar-list-row"]') !== null, "the list's rows");
  await click(button(host, "Month"));
  await settleUntil(() => host.querySelector('[data-slot="calendar-dots"] i') !== null, "the month's dots");
  const dayCell = (label: string) => [...host.querySelectorAll<HTMLElement>('[data-slot="calendar-day-cell"]')].find((c) => c.getAttribute("aria-label") === label);
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-slot="calendar-picked-day"] [data-slot="calendar-list-row"]')]
    .map((r) => [r.dataset.entry, r.hasAttribute("data-past"), r.hasAttribute("data-paused")]);
  await click(dayCell("Fri 13 Nov"));
  expect(rows()).toEqual([["cal_paused", true, true], ["cal_once", false, false]]);
  await click(dayCell("Mon 16 Nov"));
  expect(rows()).toEqual([["cal_weekly", false, false], ["cal_paused", false, true], ["cal_ny", false, false]]);
});

test("a range that fails to load shows nothing of the range before it", async () => {
  const data = world();
  let fail = false;
  mockFetch((call: FetchCall) => {
    if (fail) return jsonResponse({ error: "down" }, 500);
    const url = new URL(call.url, "http://x");
    const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to"));
    return jsonResponse({ entries: data.entries, times: data.times(from, to), from, to } satisfies CalendarDto);
  });
  const host = mount(<MemoryRouter initialEntries={["/calendar"]}><CalendarView place="page" /></MemoryRouter>).host;
  await settleUntil(() => block(host, "cal_once", local(10, 13, 16)) !== null, "this week's blocks");
  fail = true;
  // The month holds this week: the week's times must not stand in for it.
  await click(button(host, "Month"));
  await settleUntil(() => title(host) === "November 2026", "the month asked for");
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(host.querySelectorAll('[data-slot="calendar-chip"]').length).toBe(0);
});
