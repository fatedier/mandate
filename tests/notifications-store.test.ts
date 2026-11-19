import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeNotificationsSchema } from "../src/server/modules/notifications/schema.js";
import { NotificationStore } from "../src/server/modules/notifications/notification-store.js";

// Every notice Mandate sends is kept for a while: which matter it is about,
// what it said, and what each channel did with it, so a repeat, an
// escalation or a withdrawal still works after a restart.

const T0 = new Date("2026-11-02T10:00:00.000Z");

function storeAt(clock: { now: Date }) {
  const db = new Database(":memory:");
  initializeNotificationsSchema(db);
  return { db, store: new NotificationStore(db, () => clock.now) };
}

const notice = (matterKey = "thread:thr_a") => ({ matterKey, source: "agent" as const, level: "needs_you" as const, title: "Login fix needs your call", body: "The manager asks.", link: "/threads/thr_a" });

test("insert then latestOpen returns it until seen, settled or superseded", () => {
  const clock = { now: T0 };
  const { store } = storeAt(clock);
  const first = store.insert(notice());
  expect(first.id).toMatch(/^ntf_/);
  expect(store.latestOpen("thread:thr_a")?.id).toBe(first.id);
  expect(store.markSeen("thread:thr_a", T0.toISOString())).toEqual([first.id]);
  expect(store.latestOpen("thread:thr_a")).toBeNull();

  const second = store.insert(notice());
  store.markSettled("thread:thr_a", T0.toISOString());
  expect(store.latestOpen("thread:thr_a")).toBeNull();

  const third = store.insert(notice());
  const fourth = store.insert(notice());
  store.supersede(third.id, fourth.id);
  expect(store.latestOpen("thread:thr_a")?.id).toBe(fourth.id);
  expect(store.openMatters().map((row) => row.id)).toEqual([fourth.id]);
  expect(second.id).not.toBe(first.id);
});

test("rows older than 30 days are pruned on insert", () => {
  const clock = { now: T0 };
  const { store } = storeAt(clock);
  const old = store.insert(notice("thread:old"));
  store.recordSend(old.id, "nch_phone", { state: "sent", ref: "7", error: null });
  clock.now = new Date(T0.getTime() + 31 * 86_400_000);
  store.insert(notice("thread:new"));
  expect(store.get(old.id)).toBeNull();
  expect(store.sendsOf(old.id)).toStrictEqual([]);
});

test("a send is kept per channel and its state can change", () => {
  const clock = { now: T0 };
  const { store } = storeAt(clock);
  const row = store.insert(notice());
  store.recordSend(row.id, "nch_phone", { state: "sent", ref: "7", error: null });
  store.recordSend(row.id, "nch_phone", { state: "withdrawn", ref: "7", error: null });
  store.recordSend(row.id, "nch_team", { state: "failed", ref: null, error: "Forbidden: bot was blocked by the user" });
  expect(store.sendsOf(row.id).map((send) => [send.channelId, send.state, send.ref, send.error])).toEqual([
    ["nch_phone", "withdrawn", "7", null],
    ["nch_team", "failed", null, "Forbidden: bot was blocked by the user"]
  ]);
});

test("externalSendsSince counts what reached the channel in the window, not failures", () => {
  const clock = { now: T0 };
  const { store } = storeAt(clock);
  const a = store.insert(notice("thread:a"));
  store.recordSend(a.id, "nch_phone", { state: "sent", ref: "1", error: null });
  clock.now = new Date(T0.getTime() + 10 * 60_000);
  const b = store.insert(notice("thread:b"));
  store.recordSend(b.id, "nch_phone", { state: "withdrawn", ref: "2", error: null });
  const c = store.insert(notice("thread:c"));
  store.recordSend(c.id, "nch_phone", { state: "failed", ref: null, error: "x" });
  store.recordSend(c.id, "nch_other", { state: "sent", ref: "3", error: null });
  expect(store.externalSendsSince("nch_phone", T0.toISOString())).toBe(2);
  expect(store.externalSendsSince("nch_phone", new Date(T0.getTime() + 60_000).toISOString())).toBe(1);
  expect(store.oldestExternalSendSince("nch_phone", T0.toISOString())).toBe(T0.toISOString());
});

test("dueEscalations returns rows whose escalate_at has passed and clearEscalation removes them", () => {
  const clock = { now: T0 };
  const { store } = storeAt(clock);
  const due = store.insert({ ...notice("thread:due"), escalateAt: new Date(T0.getTime() + 5 * 60_000).toISOString() });
  store.insert({ ...notice("thread:later"), escalateAt: new Date(T0.getTime() + 9 * 60_000).toISOString() });
  expect(store.dueEscalations(new Date(T0.getTime() + 6 * 60_000)).map((row) => row.id)).toEqual([due.id]);
  store.clearEscalation(due.id);
  expect(store.dueEscalations(new Date(T0.getTime() + 6 * 60_000))).toStrictEqual([]);
});

test("lastWithSameText finds a repeat of the same words on the same matter", () => {
  const clock = { now: T0 };
  const { store } = storeAt(clock);
  const row = store.insert({ ...notice(), line: "Sent to: Phone." });
  expect(store.lastWithSameText("thread:thr_a", "Login fix needs your call", "The manager asks.", T0.toISOString())?.line).toBe("Sent to: Phone.");
  expect(store.lastWithSameText("thread:thr_a", "Login fix needs your call", "Other words.", T0.toISOString())).toBeNull();
  store.setLine(row.id, "Sent to: Browser, Phone.");
  expect(store.get(row.id)?.line).toBe("Sent to: Browser, Phone.");
});

test("a notice keeps the channels the personal agent named; none named is null", () => {
  const clock = { now: T0 };
  const { store } = storeAt(clock);
  expect(store.insert(notice()).namedChannels).toBeNull();
  expect(store.insert({ ...notice("thread:thr_b"), namedChannels: ["Phone", "Browser"] }).namedChannels).toEqual(["Phone", "Browser"]);
});
