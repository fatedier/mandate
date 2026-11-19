import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { deleteJson, getJson, postJson } from "./helpers/test-app.js";
import { calendarModule } from "../src/server/modules/calendar/module.js";
import { CalendarService } from "../src/server/modules/calendar/calendar-service.js";
import { CalendarStore } from "../src/server/modules/calendar/calendar-store.js";
import type { AppDeps } from "../src/server/app/deps.js";

let env: (StoresEnv & { calendar: CalendarService }) | null = null;
afterEach(() => { env?.calendar.dispose(); env?.cleanup(); env = null; });

const start = Date.parse("2026-11-13T07:40:00Z");

function app() {
  const stores = freshStoresEnv("md-calendar-routes-");
  const store = new CalendarStore(stores.store.db);
  const calendar = new CalendarService({ store, sse: { emit: () => {} } as never, timeZone: "Asia/Singapore", deliver: () => () => {}, now: () => start });
  env = Object.assign(stores, { calendar });
  const hono = new Hono();
  calendarModule.mountRoutes!(hono, { deps: { calendar } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  return { hono, calendar, store };
}

test("the page reads a range: the entries and their times with what became of each", async () => {
  const { hono, calendar } = app();
  const weekly = calendar.add({ title: "Weekly", note: "n", repeat: "0 9 * * 1" });
  const from = Date.parse("2026-11-13T00:00:00Z"), to = Date.parse("2026-11-27T00:00:00Z");
  const read = await getJson(hono, `/api/calendar?from=${from}&to=${to}`);
  expect(read.status).toBe(200);
  expect(read.body.entries.map((e: { id: string }) => e.id)).toEqual([weekly.id]);
  expect(read.body.times.map((t: { at: number; outcome: string }) => [t.at, t.outcome])).toEqual([
    [Date.parse("2026-11-16T01:00:00Z"), "due"], [Date.parse("2026-11-23T01:00:00Z"), "due"]
  ]);
  for (const bad of [`from=${from}`, `from=x&to=${to}`, `from=${to}&to=${from}`, `from=${from}&to=${from + 93 * 86_400_000}`]) {
    const refused = await getJson(hono, `/api/calendar?${bad}`);
    expect([refused.status, typeof refused.body.error]).toEqual([400, "string"]);
  }
});

test("the user pauses, resumes, skips one time and deletes, each recorded as theirs", async () => {
  const { hono, calendar, store } = app();
  const weekly = calendar.add({ title: "Weekly", note: "n", repeat: "0 9 * * 1" });
  const paused = await postJson(hono, `/api/calendar/${weekly.id}/pause`, {});
  expect([paused.status, paused.body.entry.paused?.by]).toEqual([200, "user"]);
  const resumed = await postJson(hono, `/api/calendar/${weekly.id}/resume`, {});
  expect([resumed.status, resumed.body.entry.paused]).toEqual([200, null]);
  const skipped = await postJson(hono, `/api/calendar/${weekly.id}/skip`, { at: Date.parse("2026-11-16T01:00:00Z") });
  expect([skipped.status, skipped.body.entry.next]).toEqual([200, Date.parse("2026-11-23T01:00:00Z")]);
  const badSkip = await postJson(hono, `/api/calendar/${weekly.id}/skip`, { at: "Monday" });
  expect([badSkip.status, typeof badSkip.body.error]).toEqual([400, "string"]);
  const deleted = await deleteJson(hono, `/api/calendar/${weekly.id}`);
  expect(deleted.status).toBe(200);
  expect(store.userChangesSince(0).map((c) => [c.kind, c.by])).toEqual([["delete", "user"], ["skip", "user"], ["resume", "user"], ["pause", "user"]]);
});

test("an unknown entry is a 404 with words; a once entry cannot be paused", async () => {
  const { hono, calendar } = app();
  const missing = await postJson(hono, "/api/calendar/cal_nope/pause", {});
  expect([missing.status, missing.body.error]).toEqual([404, "No calendar entry with that id."]);
  expect((await deleteJson(hono, "/api/calendar/cal_nope")).status).toBe(404);
  const once = calendar.add({ title: "Once", note: "n", at: "2h" });
  const refused = await postJson(hono, `/api/calendar/${once.id}/pause`, {});
  expect([refused.status, refused.body.error]).toEqual([400, "paused and skip are for a repeat."]);
});
