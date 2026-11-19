import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { CalendarService } from "../src/server/modules/calendar/calendar-service.js";
import { CalendarStore } from "../src/server/modules/calendar/calendar-store.js";
import { buildCalendarTools } from "../src/server/modules/calendar/tools/calendar-tools.js";
import { renderCalendarSection } from "../src/server/modules/calendar/calendar-text.js";

let env: (StoresEnv & { calendar: CalendarService }) | null = null;
afterEach(() => { env?.calendar.dispose(); env?.cleanup(); env = null; });

const ZONE = "Asia/Singapore";
const at = (iso: string) => Date.parse(iso);

function setup(startIso = "2026-11-13T07:40:00Z") {
  const stores = freshStoresEnv("md-calendar-tool-");
  let now = at(startIso);
  const store = new CalendarStore(stores.store.db);
  const delivered: string[] = [];
  const calendar = new CalendarService({ store, sse: { emit: () => {} } as never, timeZone: ZONE, deliver: (text) => { delivered.push(text); return () => {}; }, now: () => now });
  env = Object.assign(stores, { calendar });
  const tool = buildCalendarTools({ calendar, timeZone: ZONE, now: () => now })[0]!;
  const call = async (args: Record<string, unknown>) => tool.handler(args as never, toolContext({ threadId: "thr_personal", wakeId: "w1" }));
  return { tool, call, calendar, store, delivered, setNow: (iso: string) => { now = at(iso); calendar.settle(); } };
}

const idIn = (out: unknown): string => /`(cal_[A-Za-z0-9_-]{11})`/.exec(String(out))?.[1] ?? "";

test("there is one tool, calendar, described and fielded in its fixed words", () => {
  const { tool } = setup();
  expect(tool.name).toBe("calendar");
  expect(tool.description).toBe([
    "Your calendar, shown to the user on their Calendar page: what is planned for a time, once or on a repeat — a reminder for the user, or work you do yourself then. When an entry is due you are woken with its note. Actions:",
    "- add: a new entry: title, note, and either at (once) or repeat. Returns its id.",
    "- update: change an entry; what you give replaces that field. paused and skip apply to a repeat.",
    "- remove: take an entry off the calendar.",
    "- read: with id, one entry in full: its note, its rule, and the last times it was due. Without id, what is due day by day from `from` to `to`, with what was delivered on days already past."
  ].join("\n"));
  const shape = (tool.parameters as unknown as { shape: Record<string, { description?: string }> }).shape;
  expect(shape.repeat!.description).toBe('On a repeat: a standard 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1" for every Monday at 09:00. At most once an hour.');
  expect(shape.skip!.description).toBe("Update only: a day (YYYY-MM-DD) on which a repeat is not due this once.");
  expect(shape.to!.description).toBe("Read without id: the last day, as YYYY-MM-DD, at most 92 days after from. Defaults to 7 days after from.");
});

test("add answers the entry's line with its id; a refusal is in its fixed words", async () => {
  const { call, calendar } = setup();
  const out = await call({ action: "add", title: "Weekly progress notes", note: "Write the draft.", repeat: "0 9 * * 1", id: "", at: "", until: "", skip: "", from: "", to: "" });
  expect(idIn(out)).toBe(calendar.entries()[0]!.id);
  expect(String(out)).toBe(`\`${idIn(out)}\` "Weekly progress notes" · every Monday 09:00 · next Mon 16 Nov 09:00`);
  expect(await call({ action: "add", title: "t", note: "n" })).toEqual({ error: "An entry needs a title, a note, and at or repeat." });
  expect(await call({ action: "update", id: "cal_nope", title: "x" })).toEqual({ error: "No calendar entry with that id." });
  expect(await call({ action: "remove" })).toEqual({ error: "No calendar entry with that id." });
});

// A blank until is a field a model fills without meaning it, as every other
// blank: the end stays. An end goes by adding the entry again.
test("update changes what it gives; skip takes the day; a blank until keeps the end; paused pauses", async () => {
  const { call, calendar, store } = setup();
  const id = idIn(await call({ action: "add", title: "Twice", note: "n", repeat: "0 9,17 * * *", until: "2026-12-18" }));
  await call({ action: "update", id, skip: "2026-11-14" });
  expect(store.get(id)!.skips).toEqual([at("2026-11-14T01:00:00Z"), at("2026-11-14T09:00:00Z")]);
  expect(String(await call({ action: "update", id, title: "Twice a day", until: "" }))).toContain("until 18 Dec");
  expect(store.get(id)!.untilDay).toBe("2026-12-18");
  expect(String(await call({ action: "update", id, until: "2026-12-24" }))).toContain("until 24 Dec");
  const paused = String(await call({ action: "update", id, paused: true }));
  expect(paused.endsWith(" · paused")).toBe(true);
  expect(calendar.entries()[0]!.paused?.by).toBe("agent");
  expect(await call({ action: "update", id, skip: "14 Nov" })).toEqual({ error: "Give days as YYYY-MM-DD." });
  expect(await call({ action: "remove", id })).toBe(`Removed "Twice a day".`);
  expect(calendar.entries().length).toBe(0);
});

// A model fills fields it does not mean: on a one-off a zone, an end or a
// "not paused" says nothing, as add takes them. Pausing or skipping one is still refused.
test("update of a one-off with a zone, an end or paused false filled in changes what it means and refuses nothing", async () => {
  const { call, store } = setup();
  const id = idIn(await call({ action: "add", title: "Renew the cert", note: "n", at: "2h" }));
  const out = await call({ action: "update", id, title: "Renew the certificate", note: "", at: "", repeat: "", timezone: "Asia/Singapore", until: "", paused: false, skip: "" });
  expect(String(out)).toBe(`\`${id}\` "Renew the certificate" · once Fri 13 Nov 17:40`);
  expect(await call({ action: "update", id, title: "Renew it", until: "2026-12-01", timezone: "Europe/Berlin" })).toBe(`\`${id}\` "Renew it" · once Fri 13 Nov 17:40`);
  expect([store.get(id)!.cron, store.get(id)!.untilDay, store.get(id)!.pausedAt]).toEqual([null, null, null]);
  expect(await call({ action: "update", id, paused: true })).toEqual({ error: "paused and skip are for a repeat." });
  expect(await call({ action: "update", id, skip: "2026-11-13" })).toEqual({ error: "paused and skip are for a repeat." });
});

test("read of one entry gives it whole and its last times, a delivered one with how many earlier times it stood for", async () => {
  const { call, setNow } = setup("2026-11-15T00:00:00Z");
  const id = idIn(await call({ action: "add", title: "Weekly", note: "Read last week's tasks.\nWrite a short draft.", repeat: "0 9 * * 1", until: "2026-12-18" }));
  await call({ action: "update", id, skip: "2026-11-30" });
  setNow("2026-11-23T03:00:00Z");
  const out = String(await call({ action: "read", id }));
  expect(out).toContain(`\`${id}\` "Weekly"`);
  expect(out).toContain("every Monday 09:00 until 18 Dec (cron 0 9 * * 1, Asia/Singapore)");
  expect(out).toContain("Skipped: Mon 30 Nov 09:00");
  expect(out).toContain("Note:\nRead last week's tasks.\nWrite a short draft.");
  // Mandate off over the 16th: the 23rd's delivery stood for it too.
  expect(out).toContain("- Mon 23 Nov 09:00 delivered 11:00; 1 earlier time was missed too\n- Mon 16 Nov 09:00 missed");
});

test("read of days lists each day's times, with what became of the past ones, from today for a week by default", async () => {
  const { call, setNow } = setup("2026-11-15T00:00:00Z");
  const weekly = idIn(await call({ action: "add", title: "Weekly", note: "n", repeat: "0 9 * * 1" }));
  const daily = idIn(await call({ action: "add", title: "Daily", note: "n", repeat: "0 8 * * *" }));
  // Each due time reached as it comes, as the timer would.
  for (const iso of ["2026-11-16T00:00:00Z", "2026-11-16T01:00:00Z", "2026-11-16T03:00:00Z"]) setNow(iso);
  await call({ action: "update", id: daily, paused: true });
  const out = String(await call({ action: "read", from: "2026-11-16", to: "2026-11-17" }));
  expect(out).toBe([
    "Mon 16 Nov",
    `- 08:00 \`${daily}\` "Daily" · delivered 08:00`,
    `- 09:00 \`${weekly}\` "Weekly" · delivered 09:00`,
    "Tue 17 Nov",
    `- 08:00 \`${daily}\` "Daily" · paused`
  ].join("\n"));
  const week = String(await call({ action: "read" }));
  expect(week.startsWith("Mon 16 Nov")).toBe(true);
  expect(week).toContain("Mon 23 Nov");
  expect(week).not.toContain("Tue 24 Nov");
  expect(await call({ action: "read", from: "2026-11-17", to: "2026-11-16" })).toEqual({ error: "to must be on or after from, and at most 92 days after it." });
  expect(await call({ action: "read", from: "2026-11-01", to: "2027-02-02" })).toEqual({ error: "to must be on or after from, and at most 92 days after it." });
});

test("the runtime context lists the live entries and the user's changes lately", () => {
  const { calendar } = setup("2026-11-13T07:40:00Z");
  const clock = { timeZone: ZONE, now: at("2026-11-13T07:40:00Z") };
  expect(renderCalendarSection([], [], clock)).toBe("None.");
  const weekly = calendar.add({ title: "Weekly", note: "n", repeat: "0 9 * * 1" });
  const once = calendar.add({ title: "Handover", note: "n", at: "2026-11-17T10:00:00+08:00" });
  const paused = calendar.add({ title: "Nightly", note: "n", repeat: "30 9 * * 1-5", until: "2026-12-18" });
  const away = calendar.add({ title: "NY", note: "n", repeat: "0 9 * * 1", timezone: "America/New_York" });
  const gone = calendar.add({ title: "Old", note: "n", repeat: "0 10 * * *" });
  calendar.pause(paused.id, "user");
  calendar.remove(gone.id, "user");
  const section = renderCalendarSection(calendar.entries(), calendar.userChangesSince(clock.now - 3 * 86_400_000), clock);
  expect(section).toBe([
    `- \`${weekly.id}\` "Weekly" · every Monday 09:00 · next Mon 16 Nov 09:00`,
    `- \`${once.id}\` "Handover" · once Tue 17 Nov 10:00`,
    `- \`${paused.id}\` "Nightly" · weekdays 09:30 until 18 Dec · paused by the user`,
    `- \`${away.id}\` "NY" · every Monday 09:00 (America/New_York) · next Mon 16 Nov 22:00`,
    `Changed by the user lately: deleted "Old" (13 Nov 15:40); paused "Nightly" (13 Nov 15:40)`
  ].join("\n"));
});

test("a paused repeat whose last day has passed leaves the context", () => {
  const { calendar, setNow } = setup("2026-11-12T00:00:00Z");
  const ended = calendar.add({ title: "Daily", note: "n", repeat: "0 8 * * *", until: "2026-11-14" });
  const going = calendar.add({ title: "Weekly", note: "n", repeat: "0 9 * * 1" });
  calendar.pause(ended.id, "user");
  calendar.pause(going.id, "user");
  setNow("2026-11-20T00:00:00Z");
  const section = renderCalendarSection(calendar.entries(), [], { timeZone: ZONE, now: at("2026-11-20T00:00:00Z") });
  expect([section.includes("Daily"), section.includes("Weekly")]).toEqual([false, true]);
});
