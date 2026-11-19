import { expect, test } from "bun:test";
import type { PresenceReport } from "../src/shared/api/notifications.js";
import { PresenceBook } from "../src/server/modules/notifications/presence.js";
import { matterShownBy, planDelivery } from "../src/server/modules/notifications/delivery-plan.js";
import { listsMatter } from "../src/server/modules/notifications/waiting-match.js";
import type { WaitingEntryDto } from "../src/shared/api/thread-status.js";

// Where a notice goes depends on where the user is: nothing when they look at
// it, a toast in the window they are using, a system notification on the
// desktop when they are at it (the phone a few minutes later), everything
// when they are away.

const NOW = new Date("2026-11-02T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const owners = (workerId: string) => (workerId === "wkr_w" ? "thr_a" : null);

function client(overrides: Partial<PresenceReport> & { windowId: string }): PresenceReport & { seenAt: Date } {
  return {
    device: "desktop",
    shell: "browser",
    visible: true,
    focused: true,
    lastInputAt: ago(10_000),
    path: "/projects",
    canShowSystem: true,
    seenAt: NOW,
    ...overrides
  };
}

/** What "Waiting on you" lists: thread thr_a's question, and worker wkr_w's. */
const listed = (key: string) => key === "thread:thr_a" || key === "worker:wkr_w";
const plan = (matterKey: string, clients: Array<PresenceReport & { seenAt: Date }>, desktopAppOn = true) =>
  planDelivery({ matterKey, clients, now: NOW, desktopAppOn, owners, listed });

test("looking at the thread page sends nothing", () => {
  expect(plan("thread:thr_a", [client({ windowId: "c1", path: "/threads/thr_a" })])).toEqual({ kind: "looking" });
});

test("the New thread page counts as looking only for what its list shows", () => {
  const home = [client({ windowId: "c1", path: "/home" })];
  expect(plan("thread:thr_a", home)).toEqual({ kind: "looking" });
  expect(plan("worker:wkr_w", home)).toEqual({ kind: "looking" });
  // A thread with nothing waiting is not on the page.
  expect(plan("thread:thr_quiet", home)).toEqual({ kind: "in-use", toast: ["c1"] });
  expect(plan("agent:failed", home)).toEqual({ kind: "in-use", toast: ["c1"] });
  expect(plan("agent:failed", [client({ windowId: "c1", path: "/agent" })])).toEqual({ kind: "looking" });
});

test("the list shows the personal agent's own question and hold, and threads and workers by their entries", () => {
  const entry = (fields: Partial<WaitingEntryDto> & Pick<WaitingEntryDto, "kind">): WaitingEntryDto => ({
    key: "k", waiting: "input", threadId: null, threadTitle: null, workerId: null, workerName: null, text: "", place: null, ...fields
  });
  const list = [entry({ kind: "agent" }), entry({ kind: "question", threadId: "thr_a" }), entry({ kind: "worker", threadId: "thr_b", workerId: "wkr_w" })];
  expect(["agent:question", "agent:held", "thread:thr_a", "thread:thr_b", "worker:wkr_w", "worker:wkr_x", "agent:failed"].map((key) => listsMatter(list, key)))
    .toEqual([true, false, true, true, true, false, false]);
  expect(listsMatter([entry({ kind: "agent", threadId: "thr_global" })], "agent:held")).toBe(true);
});

test("a worker matter is shown by its owner thread's page with or without ?worker", () => {
  expect(matterShownBy("/threads/thr_a", "worker:wkr_w", owners, listed)).toBe(true);
  expect(matterShownBy("/threads/thr_a?worker=wkr_w", "worker:wkr_w", owners, listed)).toBe(true);
  expect(matterShownBy("/threads/thr_b", "worker:wkr_w", owners, listed)).toBe(false);
  expect(matterShownBy("/threads/thr_a", "thread:thr_b", owners, listed)).toBe(false);
});

test("a client in use anywhere takes the notice as a toast, alone", () => {
  const clients = [
    client({ windowId: "tab", visible: false, focused: false, lastInputAt: ago(60 * 60_000) }),
    client({ windowId: "app", shell: "desktop-app", visible: false, focused: false, lastInputAt: ago(60 * 60_000) }),
    client({ windowId: "phone", device: "phone", canShowSystem: false, path: "/projects" })
  ];
  expect(plan("thread:thr_a", clients)).toEqual({ kind: "in-use", toast: ["phone"] });
});

test("a window counts as in use only while visible, focused and touched in the last 3 minutes", () => {
  expect(plan("thread:thr_a", [client({ windowId: "c1", focused: false, path: "/threads/thr_a", lastInputAt: ago(30 * 60_000) })]).kind).toBe("away");
  // Untouched for over 3 minutes it is not in use: not looking, the notice
  // waits for the user to see it (read without a touch, or covered).
  expect(plan("thread:thr_a", [client({ windowId: "c1", lastInputAt: ago(3 * 60_000 + 1), path: "/threads/thr_a" })]).kind).toBe("held");
});

test("a recent desktop input without a window in use is the desk, external after 5 minutes", () => {
  const clients = [
    client({ windowId: "tab", focused: false, lastInputAt: ago(4 * 60_000) }),
    client({ windowId: "phone", device: "phone", visible: false, focused: false, lastInputAt: ago(60_000), canShowSystem: false })
  ];
  expect(plan("thread:thr_a", clients)).toEqual({ kind: "desk", system: ["tab"], externalAt: new Date(NOW.getTime() + 5 * 60_000) });
});

test("no recent input anywhere is away, every client that can show it", () => {
  const clients = [
    client({ windowId: "tab", visible: false, focused: false, lastInputAt: ago(20 * 60_000) }),
    client({ windowId: "blocked", visible: false, focused: false, lastInputAt: null, canShowSystem: false }),
    client({ windowId: "app", shell: "desktop-app", visible: false, focused: false, lastInputAt: null })
  ];
  expect(plan("thread:thr_a", clients)).toEqual({ kind: "away", system: ["tab", "app"] });
  expect(plan("thread:thr_a", [])).toEqual({ kind: "away", system: [] });
});

test("the desktop app counts only while its switch is on", () => {
  const app = [client({ windowId: "app", shell: "desktop-app", focused: false, lastInputAt: ago(20 * 60_000) })];
  expect(plan("thread:thr_a", app, false)).toEqual({ kind: "away", system: [] });
  expect(plan("thread:thr_a", app, true)).toEqual({ kind: "away", system: ["app"] });
});

test("a phone is never sent a system notification", () => {
  const phone = [client({ windowId: "phone", device: "phone", visible: false, focused: false, lastInputAt: null, canShowSystem: true })];
  expect(plan("thread:thr_a", phone)).toEqual({ kind: "away", system: [] });
});

test("an entry not heard from for 150 s is gone, and gone removes it at once", () => {
  const book = new PresenceBook();
  const report = { ...client({ windowId: "c1" }) } as PresenceReport & { seenAt?: Date };
  delete report.seenAt;
  book.report(report, NOW);
  book.report({ ...report, windowId: "c2" }, NOW);
  expect(book.live(new Date(NOW.getTime() + 149_000)).map((c) => c.windowId)).toEqual(["c1", "c2"]);
  expect(book.live(new Date(NOW.getTime() + 151_000))).toStrictEqual([]);
  book.report(report, NOW);
  book.report({ ...report, gone: true }, NOW);
  expect(book.live(NOW).map((c) => c.windowId)).toStrictEqual([]);
});

// A matter's page on screen in a desktop window that is not in use (behind
// another window, or read without a touch): the user may be reading it, or
// it may be covered — macOS reports a window under another app's maximized
// one as visible. While the desk was touched lately, the notice waits a
// little for them to see it.
test("a matter's page on screen but not in use, the desk touched in 10 minutes, holds its notice for 2 minutes", () => {
  const until = new Date(NOW.getTime() + 2 * 60_000);
  // Behind another window.
  expect(plan("thread:thr_a", [client({ windowId: "c1", path: "/threads/thr_a", focused: false, lastInputAt: ago(60_000) })])).toEqual({ kind: "held", until });
  // In front, read for 8 minutes without a touch.
  expect(plan("thread:thr_a", [client({ windowId: "c1", path: "/threads/thr_a", lastInputAt: ago(8 * 60_000) })])).toEqual({ kind: "held", until });
  // The personal agent's own matter, on its page.
  expect(plan("agent:question", [client({ windowId: "c1", path: "/agent", focused: false, lastInputAt: ago(60_000) })])).toEqual({ kind: "held", until });
});

test("a notice is not held when no desktop window has its page on screen or the desk was not touched in 10 minutes", () => {
  // Hidden (minimised, another tab, another desktop): the user does not see it.
  expect(plan("thread:thr_a", [client({ windowId: "c1", path: "/threads/thr_a", visible: false, focused: false, lastInputAt: ago(60_000) })]).kind).toBe("desk");
  // Another page on screen.
  expect(plan("thread:thr_a", [client({ windowId: "c1", path: "/projects", focused: false, lastInputAt: ago(60_000) })]).kind).toBe("desk");
  // Nobody at the desk for 10 minutes.
  expect(plan("thread:thr_a", [client({ windowId: "c1", path: "/threads/thr_a", focused: false, lastInputAt: ago(10 * 60_000 + 1) })]).kind).toBe("away");
  // A phone on the table with the page open.
  expect(plan("thread:thr_a", [client({ windowId: "p1", device: "phone", path: "/threads/thr_a", lastInputAt: ago(5 * 60_000) })]).kind).toBe("away");
});

test("a window in use elsewhere gets its toast at once rather than waiting", () => {
  expect(plan("thread:thr_a", [
    client({ windowId: "c1", path: "/threads/thr_a", focused: false, lastInputAt: ago(60_000) }),
    client({ windowId: "c2", path: "/projects" })
  ])).toEqual({ kind: "in-use", toast: ["c2"] });
});

test("asked not to hold, the plan is as it would be without the wait", () => {
  const clients = [client({ windowId: "c1", path: "/threads/thr_a", focused: false, lastInputAt: ago(60_000) })];
  expect(planDelivery({ matterKey: "thread:thr_a", clients, now: NOW, desktopAppOn: true, owners, listed, hold: false })).toEqual({ kind: "desk", system: ["c1"], externalAt: new Date(NOW.getTime() + 5 * 60_000) });
});
