import { afterEach, expect, spyOn, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { CalendarStore } from "../src/server/modules/calendar/calendar-store.js";
import { CalendarService } from "../src/server/modules/calendar/calendar-service.js";
import * as rules from "../src/server/modules/calendar/calendar-rules.js";
import { CalendarRefusal } from "../src/server/modules/calendar/calendar-rules.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const ZONE = "Asia/Singapore";
const at = (iso: string) => Date.parse(iso);

/** A clock and timers the test moves on: due callbacks run in time order. */
function fakeTime(start: number) {
  let now = start;
  let seq = 0;
  const waiting = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    timers: {
      now: () => now,
      setTimeout: (run: () => void, ms: number) => { const id = ++seq; waiting.set(id, { at: now + ms, run }); return id; },
      clearTimeout: (id: unknown) => { waiting.delete(id as number); }
    },
    to(ms: number) {
      for (;;) {
        const next = [...waiting.entries()].filter(([, t]) => t.at <= ms).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        waiting.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].run();
      }
      now = ms;
    },
    pending: () => waiting.size
  };
}

function setup(startIso = "2026-11-13T07:40:00Z", db?: StoresEnv) {
  env = db ?? freshStoresEnv("md-calendar-svc-");
  const time = fakeTime(at(startIso));
  const delivered: Array<{ text: string; id: string; inTx: boolean; woke: boolean }> = [];
  const pings: string[][] = [];
  const store = new CalendarStore(env.store.db);
  const calendar = new CalendarService({
    store,
    sse: { emit: (event: string, data: { ids: string[] }) => { if (event === SSE_EVENTS.calendarChanged) pings.push(data.ids); } } as never,
    timeZone: ZONE,
    deliver: (text, id) => {
      const record = { text, id, inTx: env!.store.db.inTransaction, woke: false };
      delivered.push(record);
      return () => { record.woke = true; };
    },
    now: time.now,
    timers: time.timers
  });
  return { calendar, store, time, delivered, pings };
}

function refusal(run: () => unknown): { message: string; status: number } | null {
  try {
    run();
    return null;
  } catch (err) {
    return err instanceof CalendarRefusal ? { message: err.message, status: err.status } : { message: `other: ${String(err)}`, status: 0 };
  }
}

const weekly = { title: "Weekly progress notes", note: "Read last week's tasks and write a short draft.", repeat: "0 9 * * 1" };

test("an entry needs a title, a note, and at or repeat, one of them only, within the limits", () => {
  const { calendar } = setup();
  const words = (input: Parameters<CalendarService["add"]>[0]) => refusal(() => calendar.add(input))?.message;
  expect(words({ title: "", note: "n", at: "1h" })).toBe("An entry needs a title, a note, and at or repeat.");
  expect(words({ title: "t", note: "  ", at: "1h" })).toBe("An entry needs a title, a note, and at or repeat.");
  expect(words({ title: "t", note: "n" })).toBe("An entry needs a title, a note, and at or repeat.");
  expect(words({ title: "t", note: "n", at: "1h", repeat: "0 9 * * 1" })).toBe("Give at or repeat, not both.");
  expect(words({ title: "x".repeat(121), note: "n", at: "1h" })).toBe("A title is at most 120 characters and a note at most 2000.");
  expect(words({ title: "t", note: "x".repeat(2001), at: "1h" })).toBe("A title is at most 120 characters and a note at most 2000.");
  expect(words({ title: "t", note: "n", at: "next week" })).toBe("at must be a relative duration like '30m' or an ISO time with timezone.");
  expect(words({ title: "t", note: "n", at: "30s" })).toBe("at must be from 1 minute to 1 year from now.");
  expect(words({ title: "t", note: "n", at: "400d" })).toBe("at must be from 1 minute to 1 year from now.");
  expect(words({ title: "t", note: "n", repeat: "*/30 * * * *" })).toBe("A repeat may be due at most once an hour.");
  expect(words({ title: "t", note: "n", repeat: "0 9 * *" })).toMatch(/^not a 5-field cron expression/);
  expect(words({ title: "t", note: "n", repeat: "0 9 * * 1", until: "18 Dec" })).toBe("Give days as YYYY-MM-DD.");
  // Fri 13 Nov: the first Monday is the 16th, after an until of the 15th.
  expect(words({ title: "t", note: "n", repeat: "0 9 * * 1", until: "2026-11-15" })).toBe("That repeat is never due by its until day.");
  expect(calendar.entries().length).toBe(0);
});

test("an entry added has its id, its rule, its words and its next time, and the page is told", () => {
  const { calendar, pings } = setup();
  const entry = calendar.add({ ...weekly, until: "2026-12-18" });
  expect(entry.id).toMatch(/^cal_[A-Za-z0-9_-]{11}$/);
  expect(entry.once).toBeNull();
  expect(entry.repeat).toEqual({ cron: "0 9 * * 1", timezone: ZONE, until: "2026-12-18", words: "Every Monday 09:00" });
  expect(entry.next).toBe(at("2026-11-16T01:00:00Z"));
  const once = calendar.add({ title: "Review meeting", note: "List the open comments.", at: "20m" });
  expect([once.once?.at, once.next, once.repeat]).toEqual([at("2026-11-13T08:00:00Z"), at("2026-11-13T08:00:00Z"), null]);
  expect(pings).toEqual([[entry.id], [once.id]]);
});

// A title is one line: the agent's context and the wake's first line hold it.
test("a title with line breaks or runs of spaces is kept as one line, on add and on update", () => {
  const { calendar } = setup();
  const entry = calendar.add({ title: "  Renew\nthe   cert\t ", note: "Line one\nLine two", at: "2h" });
  expect([entry.title, entry.note]).toEqual(["Renew the cert", "Line one\nLine two"]);
  expect(calendar.update(entry.id, { title: "Renew\r\nit" }).title).toBe("Renew it");
});

test("a due time is delivered once, inside the write, woken after it, and recorded; the repeat steps on", () => {
  const { calendar, store, time, delivered, pings } = setup("2026-11-16T00:30:00Z");
  const entry = calendar.add(weekly);
  pings.length = 0;
  time.to(at("2026-11-16T01:00:00Z"));
  expect(delivered.map((d) => [d.text, d.id, d.inTx, d.woke])).toEqual([[
    `Calendar: "Weekly progress notes" (every Monday 09:00) is due.\nRead last week's tasks and write a short draft.`, entry.id, true, true
  ]]);
  expect(store.recentTimes(entry.id, 5).map((t) => [t.dueMs, t.outcome, t.deliveredMs])).toEqual([[at("2026-11-16T01:00:00Z"), "delivered", at("2026-11-16T01:00:00Z")]]);
  expect(calendar.entries()[0]!.next).toBe(at("2026-11-23T01:00:00Z"));
  expect(pings).toEqual([[entry.id]]);
  time.to(at("2026-11-23T00:59:00Z"));
  expect(delivered.length).toBe(1);
});

test("delivered within 5 minutes of its time it is on time; later it says when it was due and when it came", () => {
  const { calendar, store, time, delivered } = setup("2026-11-16T00:30:00Z");
  const entry = calendar.add(weekly);
  // The timer is held up (a sleeping machine): it runs 4 minutes late, then 6 the next week.
  store.update(entry.id, { nextDueMs: at("2026-11-16T01:00:00Z") });
  calendar.dispose();
  const late = (iso: string) => { time.to(at(iso)); calendar.settle(); };
  late("2026-11-16T01:04:00Z");
  late("2026-11-23T01:06:00Z");
  expect(delivered.map((d) => d.text.split("\n")[0])).toEqual([
    `Calendar: "Weekly progress notes" (every Monday 09:00) is due.`,
    `Calendar: "Weekly progress notes" (every Monday 09:00) was due at 09:00 and comes late, at 09:06.`
  ]);
});

test("after a gap, each passed time is recorded and only the last deliverable one is delivered, late", () => {
  const { calendar, store, time, delivered } = setup("2026-11-15T00:00:00Z");
  const entry = calendar.add(weekly);
  calendar.update(entry.id, { skip: "2026-11-23" });
  calendar.dispose();
  time.to(at("2026-12-07T03:12:00Z"));
  calendar.start();
  expect(store.recentTimes(entry.id, 10).map((t) => [new Date(t.dueMs).toISOString().slice(0, 10), t.outcome]).reverse()).toEqual([
    ["2026-11-16", "missed"], ["2026-11-23", "skipped"], ["2026-11-30", "missed"], ["2026-12-07", "delivered"]
  ]);
  expect(delivered.map((d) => d.text.split("\n")[0])).toEqual([
    `Calendar: "Weekly progress notes" (every Monday 09:00) was due at 09:00 and comes late, at 11:12; 2 earlier times were missed too.`
  ]);
  expect(calendar.entries()[0]!.next).toBe(at("2026-12-14T01:00:00Z"));
});

test("a gap whose last time is skipped records it and delivers nothing", () => {
  const { calendar, store, time, delivered } = setup("2026-11-15T00:00:00Z");
  const entry = calendar.add(weekly);
  calendar.update(entry.id, { skip: "2026-11-30" });
  calendar.dispose();
  time.to(at("2026-11-30T05:00:00Z"));
  calendar.start();
  expect(delivered.length).toBe(0);
  expect(store.recentTimes(entry.id, 5).map((t) => t.outcome)).toEqual(["skipped", "missed", "missed"]);
});

test("one missed time before a late one says so in the singular", () => {
  const { calendar, time, delivered } = setup("2026-11-15T00:00:00Z");
  calendar.add({ ...weekly, title: "B" });
  calendar.dispose();
  time.to(at("2026-11-23T05:00:00Z"));
  calendar.start();
  expect(delivered.map((d) => d.text.split("\n")[0])).toEqual([
    `Calendar: "B" (every Monday 09:00) was due at 09:00 and comes late, at 13:00; 1 earlier time was missed too.`
  ]);
});

test("a late time from another day names its day", () => {
  const { calendar, time, delivered } = setup("2026-11-15T00:00:00Z");
  calendar.add({ title: "Bill", note: "Read the bill.", at: "2026-11-16T10:00:00+08:00" });
  calendar.dispose();
  time.to(at("2026-11-17T01:30:00Z"));
  calendar.start();
  expect(delivered.map((d) => d.text.split("\n")[0])).toEqual([
    `Calendar: "Bill" (once Mon 16 Nov 10:00) was due at Mon 16 Nov 10:00 and comes late, at 09:30.`
  ]);
});

test("a paused repeat records its times as paused and wakes no one; resumed, it goes on from the next", () => {
  const { calendar, store, time, delivered } = setup("2026-11-15T00:00:00Z");
  const entry = calendar.add(weekly);
  calendar.pause(entry.id, "user");
  expect(calendar.entries()[0]!.paused?.by).toBe("user");
  expect(calendar.entries()[0]!.next).toBeNull();
  time.to(at("2026-11-23T02:00:00Z"));
  expect(delivered.length).toBe(0);
  expect(store.recentTimes(entry.id, 5).map((t) => t.outcome)).toEqual(["paused", "paused"]);
  calendar.resume(entry.id, "user");
  time.to(at("2026-11-30T01:00:00Z"));
  expect(delivered.length).toBe(1);
  expect(delivered[0]!.text.startsWith(`Calendar: "Weekly progress notes" (every Monday 09:00) is due.`)).toBe(true);
  expect(store.userChangesSince(0).map((c) => c.kind)).toEqual(["resume", "pause"]);
});

test("the agent's update changes what it gives; paused and skip are for a repeat; a skip takes every time that day", () => {
  const { calendar, store } = setup();
  const once = calendar.add({ title: "Once", note: "n", at: "2h" });
  expect(refusal(() => calendar.update(once.id, { paused: true }))?.message).toBe("paused and skip are for a repeat.");
  expect(refusal(() => calendar.update(once.id, { skip: "2026-11-13" }))?.message).toBe("paused and skip are for a repeat.");
  expect(refusal(() => calendar.update("cal_nope", { title: "x" }))).toEqual({ message: "No calendar entry with that id.", status: 404 });
  const twice = calendar.add({ title: "Twice", note: "n", repeat: "0 9,17 * * *" });
  calendar.update(twice.id, { skip: "2026-11-14" });
  expect(store.get(twice.id)!.skips).toEqual([at("2026-11-14T01:00:00Z"), at("2026-11-14T09:00:00Z")]);
  calendar.update(twice.id, { skip: "2026-11-15" });
  expect(store.get(twice.id)!.skips.length).toBe(4);
  const monday = calendar.add(weekly);
  expect(refusal(() => calendar.update(monday.id, { skip: "2026-11-17" }))?.message).toBe("That day is not one of its due days.");
  const changed = calendar.update(monday.id, { title: "Weekly", until: "2026-12-18", timezone: "America/New_York" });
  expect([changed.title, changed.note, changed.repeat?.until, changed.repeat?.timezone]).toEqual(["Weekly", weekly.note, "2026-12-18", "America/New_York"]);
  // A blank until is not given: the end stays.
  expect(calendar.update(monday.id, { until: " " }).repeat?.until).toBe("2026-12-18");
  const moved = calendar.update(once.id, { repeat: "0 8 * * *" });
  expect([moved.once, moved.repeat?.words]).toEqual([null, "Daily 08:00"]);
  expect(calendar.update(once.id, { at: "3h" }).repeat).toBeNull();
});

test("the page skips one time; a removed entry leaves the calendar and its timer", () => {
  const { calendar, store, time, delivered } = setup("2026-11-15T00:00:00Z");
  const twice = calendar.add({ title: "Twice", note: "n", repeat: "0 9,17 * * *" });
  calendar.skipTime(twice.id, at("2026-11-15T01:00:00Z"), "user");
  expect(store.get(twice.id)!.skips).toEqual([at("2026-11-15T01:00:00Z")]);
  expect(refusal(() => calendar.skipTime(twice.id, at("2026-11-15T02:00:00Z"), "user"))?.message).toBe("That day is not one of its due days.");
  calendar.remove(twice.id, "user");
  expect(calendar.entries().length).toBe(0);
  time.to(at("2026-11-16T00:00:00Z"));
  expect(delivered.length).toBe(0);
  expect(store.userChangesSince(0).map((c) => [c.kind, c.dueMs])).toEqual([["delete", null], ["skip", at("2026-11-15T01:00:00Z")]]);
  expect(refusal(() => calendar.remove(twice.id, "user"))?.status).toBe(404);
});

test("a range lists recorded times and the times still ahead, skipped and paused ones marked", () => {
  const { calendar, time } = setup("2026-11-15T00:00:00Z");
  const a = calendar.add(weekly);
  const b = calendar.add({ title: "Daily", note: "n", repeat: "0 8 * * *" });
  calendar.update(a.id, { skip: "2026-11-23" });
  time.to(at("2026-11-16T03:00:00Z"));
  calendar.pause(b.id, "user");
  const dto = calendar.range(at("2026-11-16T00:00:00Z"), at("2026-11-24T00:00:00Z"));
  const of = (id: string) => dto.times.filter((t) => t.entryId === id).map((t) => [new Date(t.at).toISOString().slice(5, 16), t.outcome]);
  expect(of(a.id)).toEqual([["11-16T01:00", "delivered"], ["11-23T01:00", "skipped"]]);
  expect(of(b.id).slice(0, 3)).toEqual([["11-16T00:00", "delivered"], ["11-17T00:00", "paused"], ["11-18T00:00", "paused"]]);
  expect(dto.entries.map((e) => e.id)).toEqual([a.id, b.id]);
});

// An hourly repeat's month is a thousand croner steps (~75 ms): the page asks
// again on every change, so a rule's times in a range are worked out once.
test("a range asked again works out no repeat's times a second time, and shows what changed since: a skip, a pause, a delivery, a new rule", () => {
  const { calendar, time } = setup("2026-11-15T00:00:00Z");
  const hourly = calendar.add({ title: "Hourly", note: "n", repeat: "0 * * * *" });
  const from = at("2026-11-15T00:00:00Z"), to = at("2026-11-17T00:00:00Z");
  const of = () => calendar.range(from, to).times.filter((t) => t.entryId === hourly.id);
  expect(of().length).toBe(47);
  const expanded = spyOn(rules, "dueTimesBetween");
  // The range's own working out, not the next time an entry says.
  const ofRange = () => expanded.mock.calls.filter(([, , end]) => end === to).length;
  try {
    expect(of().length).toBe(47);
    expect(ofRange()).toBe(0);
    calendar.skipTime(hourly.id, at("2026-11-16T05:00:00Z"), "user");
    calendar.pause(hourly.id, "user");
    calendar.resume(hourly.id, "user");
    time.to(at("2026-11-15T02:30:00Z"));
    const now = of();
    expect(now.find((t) => t.at === at("2026-11-16T05:00:00Z"))?.outcome).toBe("skipped");
    expect(now.filter((t) => t.at <= at("2026-11-15T02:00:00Z")).map((t) => t.outcome)).toEqual(["delivered", "delivered"]);
    expect(now.length).toBe(47);
    calendar.update(hourly.id, { repeat: "0 */2 * * *" });
    expect(of().length).toBe(2 + 22);
  } finally {
    expanded.mockRestore();
  }
});

// Skips are kept for good (the page draws them gone, the record keeps them):
// the next time looks past only those still ahead.
test("a repeat with many skips behind it says its next time, looking past only the skips ahead", () => {
  const { calendar, store } = setup("2026-11-15T00:00:00Z");
  const hourly = calendar.add({ title: "Hourly", note: "n", repeat: "0 * * * *" });
  const behind = Array.from({ length: 300 }, (_, i) => at("2026-11-02T00:00:00Z") + i * 3_600_000);
  store.update(hourly.id, { skips: [...behind, at("2026-11-15T01:00:00Z")] });
  const looked = spyOn(rules, "dueTimesAfterMs");
  try {
    expect(calendar.entry(hourly.id).next).toBe(at("2026-11-15T02:00:00Z"));
    expect(looked.mock.calls.map(([, , max]) => max)).toEqual([2]);
  } finally {
    looked.mockRestore();
  }
});

test("a time moved out of a daylight-saving gap can be skipped from the page, and comes due and is recorded", () => {
  const { calendar, time, delivered, store } = setup("2027-03-13T08:00:00Z");
  const moved = at("2027-03-14T07:30:00Z"); // 02:30 New York does not happen that day: 03:30 EDT
  const nightly = calendar.add({ title: "Nightly", note: "n", repeat: "30 2 * * *", timezone: "America/New_York" });
  const other = calendar.add({ title: "Nightly too", note: "n", repeat: "30 2 * * *", timezone: "America/New_York" });
  expect(calendar.entry(nightly.id).next).toBe(moved);
  calendar.skipTime(other.id, moved, "user");
  time.to(moved + 60_000);
  expect(delivered.map((d) => d.id)).toEqual([nightly.id]);
  expect(store.recentTimes(nightly.id, 5).map((t) => [t.dueMs, t.outcome])).toEqual([[moved, "delivered"]]);
  expect(store.recentTimes(other.id, 5).map((t) => [t.dueMs, t.outcome])).toEqual([[moved, "skipped"]]);
  expect(calendar.entry(nightly.id).next).toBe(at("2027-03-15T06:30:00Z"));
});

test("a new service on the same database delivers nothing twice, and re-arms what is left", () => {
  const first = setup("2026-11-16T00:30:00Z");
  first.calendar.add(weekly);
  first.time.to(at("2026-11-16T01:00:00Z"));
  first.calendar.dispose();
  const again = setup("2026-11-16T01:00:30Z", env!);
  again.calendar.start();
  expect(again.delivered.length).toBe(0);
  again.time.to(at("2026-11-23T01:00:00Z"));
  expect(again.delivered.length).toBe(1);
});

test("a backlog longer than one walk is recorded whole before the latest time is delivered", () => {
  const { calendar, store, time, delivered } = setup("2026-01-01T00:30:00Z");
  const entry = calendar.add({ title: "Hourly", note: "n", repeat: "0 * * * *" });
  calendar.dispose();
  // Over 3,000 hourly times: from 01:00 on 1 Jan to 05:00 on 6 May (UTC), caught up late.
  time.to(at("2026-05-06T05:30:00Z"));
  calendar.start();
  const total = (at("2026-05-06T05:00:00Z") - at("2026-01-01T01:00:00Z")) / 3_600_000 + 1;
  expect(total > 3000).toBe(true);
  const rows = store.db.prepare("select outcome, count(*) as n from calendar_times where entry_id = ? group by outcome order by outcome").all(entry.id);
  expect(rows).toEqual([{ outcome: "delivered", n: 1 }, { outcome: "missed", n: total - 1 }]);
  expect(delivered[0]!.text.split("\n")[0]!.endsWith(`${total - 1} earlier times were missed too.`)).toBe(true);
  expect(calendar.entries()[0]!.next).toBe(at("2026-05-06T06:00:00Z"));
});

test("a time already passed cannot be skipped, from the page or by the day", () => {
  const { calendar, time } = setup("2026-11-16T00:30:00Z");
  const entry = calendar.add(weekly);
  time.to(at("2026-11-16T01:30:00Z"));
  expect(refusal(() => calendar.skipTime(entry.id, at("2026-11-16T01:00:00Z"), "user"))?.message).toBe("That time has passed.");
  expect(refusal(() => calendar.update(entry.id, { skip: "2026-11-16" }))?.message).toBe("That day is not one of its due days.");
});

test("an absolute time needs its offset and a real date", () => {
  const { calendar } = setup();
  const words = (when: string) => refusal(() => calendar.add({ title: "t", note: "n", at: when }))?.message ?? null;
  const bad = "at must be a relative duration like '30m' or an ISO time with timezone.";
  expect(words("2026-11-14T10:00:00")).toBe(bad);
  expect(words("2026-11-31T10:00:00Z")).toBe(bad);
  expect(words("Nov 14 2026 10:00 GMT+8")).toBe(bad);
  expect(words("2026-11-14T10:00:00+08:00")).toBeNull();
  expect(words("2026-11-14T02:00Z")).toBeNull();
});
