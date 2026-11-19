import { useThreadChatInSight } from "../../src/client/routes/threads/thread-chat-sight.js";
import { expect, jest, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type Location } from "react-router";
import { HistoryLocationContext } from "@/lib/covered-route";
import { NotificationsClient, type ToastApi } from "@/shell/NotificationsClient";
import { dropNoticeCards, handleShow, handleWithdraw } from "@/lib/in-app-notifications";
import { afterStreamReconnect } from "@/hooks/useSnapshotSubscription";
import { NOTICE_TOASTER_ID, NoticeToaster } from "@/components/NoticeCard";
import { toast, type ExternalToast } from "sonner";
import type { ReactElement } from "react";
import { deviceKind, pageNotifySupport } from "@/lib/notification-support";
import { clickedLink, type DesktopNotifier } from "@/lib/desktop-notify";
import { AGENT_QUESTION_MATTER, type NotificationShowEvent, type PresenceReport } from "@shared/api/notifications";
import { onCleanup } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { fakeClock } from "../helpers/fake-clock.js";
import { mount, mountAsync, settle, settleUntil } from "../helpers/mount.js";

// Each window says where it is, and shows the notices meant for it: a toast
// while the user is in it, else a system notification.

/** Sets a window or navigator property for this test, restored from its own
 *  descriptor afterwards. */
function setFor<T extends object>(target: T, key: string, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  onCleanup(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  });
}

class FakeNotification {
  static permission = "granted";
  static made: FakeNotification[] = [];
  closed = false;
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public title: string, public options: { body?: string; tag?: string }) {
    FakeNotification.made.push(this);
  }
  close() {
    this.closed = true;
  }
}

/** The matter a card's id names: each card has an id of its own, the matter
 *  and a count (a card that replaces another is a new one). */
const matterOf = (id: string | number | undefined) => String(id).replace(/#\d+$/, "");

function fakeToast() {
  const shown: Array<{ title: string; options: Parameters<ToastApi>[1] }> = [];
  const cards: Array<{ jsx: (id: string | number) => ReactElement; options: Parameters<ToastApi["custom"]>[1] }> = [];
  // Taken back, by matter, and by the card's own id.
  const dismissed: string[] = [];
  const dismissedIds: string[] = [];
  const toast = Object.assign((title: string, options: Parameters<ToastApi>[1]) => { shown.push({ title, options }); return title; }, {
    dismiss: (id?: string | number) => { dismissed.push(matterOf(id)); dismissedIds.push(String(id)); return id; },
    custom: (jsx: (id: string | number) => ReactElement, options?: Parameters<ToastApi["custom"]>[1]) => { cards.push({ jsx, options }); return options?.id ?? ""; }
  }) as ToastApi;
  return { toast, shown, cards, dismissed, dismissedIds };
}

const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name)!;

/** The notices as the app draws them: the notices' own toaster with sonner's
 *  real toasts, on the fake clock. `dismissed` holds the matters of the cards
 *  taken back; `shown` which of some titles are on screen; `card(title)` one
 *  of them (sonner's own toast element, which Tab reaches first). */
async function realNotices() {
  const dismissed: string[] = [];
  const api = Object.assign((title: string, options?: ExternalToast) => toast(title, options), {
    custom: toast.custom,
    dismiss: (id?: string | number) => { dismissed.push(matterOf(id)); return toast.dismiss(id); }
  }) as ToastApi;
  const { reports } = await render({ toast: api });
  const windowId = reports()[0]!.windowId;
  fakeClock();
  onCleanup(dropNoticeCards);
  const { host } = mount(<NoticeToaster />);
  const notify = async (title: string, level: "news" | "needs_you", key = `thread:${title}`) => {
    act(() => { handleShow(show(windowId, { toast: [windowId], key, title, body: "", link: "/tasks", level })); });
    await advance(1);
  };
  const cards = () => [...host.querySelectorAll<HTMLElement>('[data-sonner-toast][data-removed="false"]')];
  const card = (title: string) => cards().find((c) => c.textContent?.includes(title))!;
  const shown = (...titles: string[]) => titles.filter((title) => cards().some((c) => c.textContent?.includes(title)));
  return { host, notify, dismissed, card, shown };
}

/** Moves the fake clock on in short steps, each its own act, so what React
 *  does between timers (sonner takes a card away 200 ms after it is
 *  dismissed) and the microtasks they queue happen on time, as in a
 *  browser. */
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= 50) await act(async () => { jest.advanceTimersByTime(Math.min(50, left)); });
};
/** The pointer comes onto `on`: what the browser sends as it crosses into it. */
const pointerOnto = (on: Element) => act(() => { on.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true })); });
const focusOn = (on: HTMLElement) => act(() => { on.focus(); });
const blurFrom = (on: HTMLElement) => act(() => { on.blur(); });

/** Makes the page hidden or shown again for this test, as the browser tells
 *  it: document.hidden and a visibilitychange. */
function pageHidden(): (hidden: boolean) => void {
  let hidden = false;
  const own = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  onCleanup(() => {
    if (own) Object.defineProperty(document, "hidden", own);
    else delete (document as { hidden?: boolean }).hidden;
  });
  return (next) => act(() => { hidden = next; document.dispatchEvent(new window.Event("visibilitychange")); });
}

function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-where>{location.pathname}{location.search}</span>
      <button type="button" data-go onClick={() => navigate("/home")}>go</button>
    </>
  );
}

async function render(options: { toast?: ToastApi; path?: string; desktop?: DesktopNotifier } = {}) {
  const calls = mockFetch(() => jsonResponse({ ok: true }));
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={[options.path ?? "/projects"]}>
      <NotificationsClient toast={options.toast ?? fakeToast().toast} {...(options.desktop ? { desktop: options.desktop } : {})} />
      <Where />
    </MemoryRouter>
  );
  const reports = () => calls.filter((c) => c.url.endsWith("/api/notifications/presence")).map((c) => JSON.parse(String(c.init?.body)) as PresenceReport);
  await settleUntil(() => reports().length > 0, "the first report");
  return { host, reports, where: () => host.querySelector("[data-where]")!.textContent };
}

const show = (windowId: string, overrides: Partial<NotificationShowEvent> = {}): NotificationShowEvent => ({
  key: "thread:thr_a", title: "Login fix needs your call", body: "The manager asks.", link: "/threads/thr_a", level: "needs_you", toast: [], system: [], ...overrides
});

test("the shell reports presence on mount with the page's path and again when the route changes", async () => {
  // A window in the background: its page changes are not the user's input
  // (happy-dom's document has the focus by default).
  setFor(document, "hasFocus", () => false);
  const { host, reports } = await render();
  const first = reports()[0]!;
  expect(first.path).toBe("/projects");
  expect(first.shell).toBe("browser");
  expect(first.device).toBe("desktop");
  expect(first.windowId.length).toBeGreaterThan(8);
  expect(first.lastInputAt).toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-go]")!.click(); });
  await settleUntil(() => reports().some((r) => r.path === "/home"), "a report from /home");
  expect(new Set(reports().map((r) => r.windowId)).size).toBe(1);
  expect(reports().find((r) => r.path === "/home")!.lastInputAt).toBeNull();
});

test("input reports at most once in 15 seconds", async () => {
  onCleanup(() => setSystemTime());
  const { reports } = await render();
  const before = reports().length;
  await act(async () => {
    window.dispatchEvent(new CustomEvent("pointerdown"));
    window.dispatchEvent(new CustomEvent("keydown"));
  });
  await settle(5);
  expect(reports().length).toBe(before + 1);
  expect(reports().at(-1)!.lastInputAt).not.toBeNull();
  const reported = Date.now();
  const inputAt = async (ms: number) => {
    setSystemTime(new Date(reported + ms));
    await act(async () => { window.dispatchEvent(new CustomEvent("pointerdown")); });
    await settle(5);
  };
  await inputAt(14_000);
  expect(reports().length).toBe(before + 1);
  await inputAt(15_500);
  expect(reports().length).toBe(before + 2);
});

test("pagehide beacons gone", async () => {
  const beacons: Array<{ url: string; body: string }> = [];
  setFor(navigator, "sendBeacon", (url: string, body: Blob) => { void body.text().then((text) => beacons.push({ url, body: text })); return true; });
  const { reports } = await render();
  await act(async () => { window.dispatchEvent(new CustomEvent("pagehide")); });
  await settleUntil(() => beacons.length > 0, "a beacon");
  expect(beacons[0]!.url).toBe("/api/notifications/presence");
  expect(JSON.parse(beacons[0]!.body)).toEqual({ windowId: reports()[0]!.windowId, gone: true });
});

// A notice is a card in the notices' own corner, apart from feedback toasts;
// one that needs the user stays until it is opened, closed or withdrawn.
test("a needs-you show for this window's toast list is a notice card that stays: Open navigates, × closes it, a withdraw takes it back", async () => {
  const t = fakeToast();
  const { reports, where } = await render({ toast: t.toast });
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { toast: [windowId] })); });
  expect(t.shown).toEqual([]);
  expect(t.cards.map((c) => [matterOf(c.options?.id), c.options?.toasterId, c.options?.duration])).toEqual([["thread:thr_a", NOTICE_TOASTER_ID, Infinity]]);
  const card = (await mountAsync(t.cards[0]!.jsx("thread:thr_a"))).host;
  expect(card.textContent).toContain("Login fix needs your call");
  expect(card.textContent).toContain("The manager asks.");
  await act(async () => { buttonNamed(card, "Open").click(); });
  expect(where()).toBe("/threads/thr_a");
  expect(t.dismissed).toEqual(["thread:thr_a"]);
  // Closed with ×: it goes, and nothing opens.
  await act(async () => { handleShow(show(windowId, { toast: [windowId], key: "thread:thr_b", link: "/threads/thr_b" })); });
  const second = (await mountAsync(t.cards[1]!.jsx("thread:thr_b"))).host;
  await act(async () => { buttonNamed(second, "Dismiss").click(); });
  expect(t.dismissed.at(-1)).toBe("thread:thr_b");
  expect(where()).toBe("/threads/thr_a");
  // A withdraw takes back the card still shown, and nothing for one already gone.
  await act(async () => { handleShow(show(windowId, { toast: [windowId], key: "thread:thr_c", link: "/threads/thr_c" })); });
  const before = t.dismissed.length;
  handleWithdraw({ key: "thread:thr_a" });
  handleWithdraw({ key: "thread:thr_c" });
  expect(t.dismissed.slice(before)).toEqual(["thread:thr_c"]);
});

// A notice that asks nothing (news: a task ready for review) goes by itself
// after 8 seconds on screen; one that needs the user stays until opened or
// closed. sonner ends neither: the card keeps its own time.
test("a news notice card goes by itself after 8 seconds; a needs-you one stays", async () => {
  const n = await realNotices();
  await n.notify("Docs move is done", "news");
  await n.notify("May the test use staging?", "needs_you");
  await advance(7_998);
  expect(n.shown("Docs move is done", "May the test use staging?")).toEqual(["Docs move is done", "May the test use staging?"]);
  await advance(1);
  expect(n.dismissed).toEqual(["thread:Docs move is done"]);
  await advance(60_000);
  expect(n.shown("Docs move is done", "May the test use staging?")).toEqual(["May the test use staging?"]);
  // Gone by itself: a later reconnect has no card of it to take back.
  dropNoticeCards();
  expect(n.dismissed).toEqual(["thread:Docs move is done", "thread:May the test use staging?"]);
});

// While the pointer is on the notices, the keys' focus is in them, or the page
// is hidden, a news card's time stands still, each of them holding it on its
// own (sonner's own hold lets go when its list changes down to one card,
// under a pointer that has not moved). It goes on with the time it had left.
test("a news card's time stands still while the pointer or the keys' focus is in the notices, or the page is hidden", async () => {
  const hidden = pageHidden();
  const n = await realNotices();
  await n.notify("Docs move is done", "news");
  const card = n.card("Docs move is done");
  const open = buttonNamed(card, "Open");
  await advance(5_000);
  pointerOnto(card);
  await advance(60_000);
  // From the pointer to the keys, in sonner's own toast element first.
  focusOn(card);
  pointerOnto(document.body);
  await advance(60_000);
  focusOn(open);
  await advance(60_000);
  // Focus leaves while the pointer is back on it: the pointer still holds it.
  pointerOnto(open);
  blurFrom(open);
  await advance(60_000);
  expect(n.dismissed).toEqual([]);
  // Out of the window altogether.
  act(() => { open.dispatchEvent(new window.PointerEvent("pointerout", { bubbles: true, relatedTarget: null })); });
  await advance(2_000);
  hidden(true);
  await advance(60_000);
  hidden(false);
  await advance(999);
  expect(n.dismissed).toEqual([]);
  await advance(1);
  expect(n.dismissed).toEqual(["thread:Docs move is done"]);
});

// The notices watch the pointer and the keys' focus whatever cards they show,
// a question alone too: a news card that comes while either is already there
// waits, and one that comes after they left has its time.
test("a news card that comes while the pointer or the keys' focus is in the notices waits until they leave, whatever was shown before", async () => {
  const n = await realNotices();
  await n.notify("May the test use staging?", "needs_you");
  pointerOnto(n.card("May the test use staging?"));
  await n.notify("Docs move is done", "news");
  await advance(60_000);
  expect(n.dismissed).toEqual([]);
  // Taken back while the pointer is there; then the pointer leaves the question.
  act(() => { handleWithdraw({ key: "thread:Docs move is done" }); });
  await advance(1_000);
  pointerOnto(document.body);
  await n.notify("Release notes are ready", "news");
  await advance(8_000);
  expect(n.dismissed).toEqual(["thread:Docs move is done", "thread:Release notes are ready"]);
  // The keys' focus on the question.
  focusOn(n.card("May the test use staging?"));
  await n.notify("The changelog is written", "news");
  await advance(60_000);
  expect(n.dismissed).toHaveLength(2);
  blurFrom(n.card("May the test use staging?"));
  await advance(8_000);
  expect(n.dismissed.at(-1)).toBe("thread:The changelog is written");
});

// A browser need not say focus left a card that is taken away while it has
// it (Firefox does not): the cards still there go on with their time.
test("a card taken away while it has the keys' focus no longer holds the others", async () => {
  const n = await realNotices();
  await n.notify("Docs move is done", "news");
  await n.notify("May the test use staging?", "needs_you");
  const question = n.card("May the test use staging?");
  focusOn(question);
  await advance(60_000);
  // Gone without a focusout, as Firefox does it.
  question.addEventListener("focusout", (event) => event.stopImmediatePropagation(), { capture: true });
  act(() => { buttonNamed(question, "Dismiss").click(); });
  await advance(1_000);
  expect(n.shown("May the test use staging?")).toEqual([]);
  await advance(7_999);
  expect(n.dismissed.at(-1)).toBe("thread:Docs move is done");
});

// sonner shows three cards and keeps the older ones hidden behind them: a
// news card's 8 seconds count only while it is shown.
test("a news card hidden behind three newer ones has its time once it shows", async () => {
  const n = await realNotices();
  await n.notify("Docs move is done", "news");
  await n.notify("May the test use staging?", "needs_you");
  await n.notify("May the release go out?", "needs_you");
  await n.notify("May the old branch go?", "needs_you");
  expect(n.card("Docs move is done").getAttribute("data-visible")).toBe("false");
  await advance(60_000);
  expect(n.dismissed).toEqual([]);
  act(() => { handleWithdraw({ key: "thread:May the old branch go?" }); });
  await advance(1_000);
  expect(n.card("Docs move is done").getAttribute("data-visible")).toBe("true");
  await advance(6_999);
  expect(n.dismissed).toEqual(["thread:May the old branch go?"]);
  await advance(1_000);
  expect(n.dismissed).toEqual(["thread:May the old branch go?", "thread:Docs move is done"]);
});

// A later notice of the same matter is a card of its own, with its own time:
// the one it replaces goes, and whatever that one does as it goes (its own
// time running out during its way out) leaves the new one alone.
test("a notice that replaces one of the same matter is a new card; the old one goes and cannot take the new one with it", async () => {
  const n = await realNotices();
  await n.notify("Docs move is done", "news", "task:tsk_1");
  await advance(7_900);
  await n.notify("Docs move is checked", "news", "task:tsk_1");
  expect(n.dismissed).toEqual(["task:tsk_1"]);
  await advance(1_000);
  expect(n.shown("Docs move is done", "Docs move is checked")).toEqual(["Docs move is checked"]);
  // The second has its own 8 seconds.
  await advance(6_098);
  expect(n.shown("Docs move is checked")).toEqual(["Docs move is checked"]);
  await advance(1_000);
  expect(n.shown("Docs move is checked")).toEqual([]);
  // A question of the matter later stays, and its withdraw takes it back.
  await n.notify("May the docs move go out?", "needs_you", "task:tsk_1");
  await advance(60_000);
  expect(n.shown("May the docs move go out?")).toEqual(["May the docs move go out?"]);
  const before = n.dismissed.length;
  act(() => { handleWithdraw({ key: "task:tsk_1" }); });
  await advance(1_000);
  expect(n.dismissed.slice(before)).toEqual(["task:tsk_1"]);
  expect(n.shown("May the docs move go out?")).toEqual([]);
});

test("a show for another window does nothing", async () => {
  const t = fakeToast();
  FakeNotification.made = [];
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  await render({ toast: t.toast });
  await act(async () => { handleShow(show("someone-else", { toast: ["someone-else"], system: ["someone-else"] })); });
  expect(t.shown).toEqual([]);
  expect(t.cards).toEqual([]);
  expect(FakeNotification.made.length).toBe(0);
});

// A card stays until it is withdrawn; a withdraw sent while the stream was
// down never arrives. After a reconnect the cards shown before it go: what
// still waits is in Waiting on you.
test("a reconnect of the event stream takes back the notice cards shown before it", async () => {
  const t = fakeToast();
  const { reports } = await render({ toast: t.toast });
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { toast: [windowId] })); });
  await act(async () => { handleShow(show(windowId, { toast: [windowId], key: "thread:thr_b", link: "/threads/thr_b" })); });
  // One closed by hand before the reconnect is not taken back again.
  const closed = (await mountAsync(t.cards[1]!.jsx("thread:thr_b"))).host;
  await act(async () => { buttonNamed(closed, "Dismiss").click(); });
  const before = t.dismissed.length;
  afterStreamReconnect();
  expect(t.dismissed.slice(before)).toEqual(["thread:thr_a"]);
});

test("a system show makes a Notification with the matter as its tag, and a withdraw closes it", async () => {
  FakeNotification.made = [];
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  setFor(window, "isSecureContext", true);
  const { reports, where } = await render();
  const windowId = reports()[0]!.windowId;
  expect(reports()[0]!.canShowSystem).toBe(true);
  await act(async () => { handleShow(show(windowId, { system: [windowId] })); });
  expect(FakeNotification.made.map((n) => [n.title, n.options.body, n.options.tag])).toEqual([["Login fix needs your call", "The manager asks.", "thread:thr_a"]]);
  await act(async () => { FakeNotification.made[0]!.onclick!(); });
  expect(where()).toBe("/threads/thr_a");
  await act(async () => { handleShow(show(windowId, { system: [windowId], body: "Still waiting." })); });
  expect(FakeNotification.made[0]!.closed).toBe(true);
  handleWithdraw({ key: "thread:thr_a" });
  expect(FakeNotification.made[1]!.closed).toBe(true);
});

// A system notification shows its first lines only: a question's says what
// is asked first, then the message it came in, on one line.
test("a question's browser notification begins with the sentence that asks", async () => {
  FakeNotification.made = [];
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  setFor(window, "isSecureContext", true);
  const { reports } = await render();
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { key: AGENT_QUESTION_MATTER, title: "Juno asks", body: "I rebased the branch on `main`.\n\nShall I push it now?", link: "/agent", system: [windowId] })); });
  expect(FakeNotification.made.map((n) => [n.title, n.options.body])).toEqual([["Juno asks", "Shall I push it now? I rebased the branch on main. Shall I push it now?"]]);
});

test("the desktop app's notification of a question begins with the sentence that asks", async () => {
  setFor(window, "__TAURI_INTERNALS__", {});
  const shown: Array<{ title: string; body: string; link: string }> = [];
  const desktop: DesktopNotifier = { ready: async () => true, show: async (notice) => { shown.push(notice); }, listen: async () => {} };
  const { reports } = await render({ desktop });
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { key: AGENT_QUESTION_MATTER, title: "Juno asks", body: "I rebased it.\n\nShall I push it now?", link: "/agent", system: [windowId] })); });
  expect(shown).toEqual([{ title: "Juno asks", body: "Shall I push it now? I rebased it. Shall I push it now?", link: "/agent" }]);
});

test("support is 'insecure' off a secure context and 'unsupported' on a phone", () => {
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  setFor(window, "isSecureContext", false);
  expect(pageNotifySupport()).toBe("insecure");
  setFor(window, "isSecureContext", true);
  expect(pageNotifySupport()).toBe("ok");
  setFor(navigator, "userAgent", "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36");
  expect(pageNotifySupport()).toBe("unsupported");
});

test("opening a notice from its notification counts as touching the window", async () => {
  FakeNotification.made = [];
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  setFor(window, "isSecureContext", true);
  onCleanup(() => setSystemTime());
  const { reports } = await render();
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { system: [windowId] })); });
  // Ten minutes idle, then the notification is clicked.
  const later = new Date(Date.now() + 10 * 60_000);
  setSystemTime(later);
  await act(async () => { FakeNotification.made[0]!.onclick!(); });
  await settleUntil(() => reports().some((r) => r.path === "/threads/thr_a"), "a report from the thread");
  const fromThread = reports().filter((r) => r.path === "/threads/thr_a").at(-1)!;
  expect(Date.parse(fromThread.lastInputAt!)).toBeGreaterThanOrEqual(later.getTime());
});

test("an Android or iPad browser is a phone whatever its mobile hint says", () => {
  setFor(navigator, "userAgentData", { mobile: false });
  setFor(navigator, "userAgent", "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 Chrome/140.0 Safari/537.36");
  expect(deviceKind()).toBe("phone");
  setFor(navigator, "userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15");
  setFor(navigator, "maxTouchPoints", 5);
  expect(deviceKind()).toBe("phone");
  setFor(navigator, "maxTouchPoints", 0);
  expect(deviceKind()).toBe("desktop");
});

test("a desktop notification's link survives a reload of the page that showed it", () => {
  const links = new Map<number, string>([[7, "/threads/thr_a"]]);
  expect(clickedLink({ notification: { id: 7 } as never }, links)).toBe("/threads/thr_a");
  // A page loaded again has no map: the link travels with the notification.
  expect(clickedLink({ notification: { id: 9, extra: { link: "/threads/thr_b" } } as never }, new Map())).toBe("/threads/thr_b");
  expect(clickedLink({ notification: null }, new Map())).toBeNull();
});

test("a notice opened on the page the window already shows is reported at once", async () => {
  FakeNotification.made = [];
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  setFor(window, "isSecureContext", true);
  const { reports } = await render({ path: "/threads/thr_a" });
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { system: [windowId] })); });
  const before = reports().length;
  await act(async () => { FakeNotification.made[0]!.onclick!(); });
  await settleUntil(() => reports().length > before, "a report after the click");
  expect(reports().at(-1)!.path).toBe("/threads/thr_a");
});

test("a toast that replaces a browser notification closes it", async () => {
  FakeNotification.made = [];
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  setFor(window, "isSecureContext", true);
  const t = fakeToast();
  const { reports } = await render({ toast: t.toast });
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { system: [windowId] })); });
  await act(async () => { handleShow(show(windowId, { toast: [windowId], body: "Still waiting." })); });
  expect(FakeNotification.made[0]!.closed).toBe(true);
  expect(t.cards).toHaveLength(1);
});

test("a newer notice of the matter shown elsewhere, or as a notification here, clears this window's older one", async () => {
  FakeNotification.made = [];
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  setFor(window, "isSecureContext", true);
  const t = fakeToast();
  const { reports } = await render({ toast: t.toast });
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { system: [windowId] })); });
  // The update went to another window in use: this one's notification goes.
  await act(async () => { handleShow(show(windowId, { toast: ["another-window"], body: "Still waiting." })); });
  expect(FakeNotification.made[0]!.closed).toBe(true);
  // A toast here, then the update as a notification here: the toast goes.
  await act(async () => { handleShow(show(windowId, { toast: [windowId] })); });
  await act(async () => { handleShow(show(windowId, { system: [windowId], body: "Later still." })); });
  expect(t.dismissed).toContain("thread:thr_a");
  expect(FakeNotification.made.at(-1)!.closed).toBe(false);
});

test("a page changed in a focused window counts as touching it, Back and Forward included", async () => {
  setFor(document, "hasFocus", () => true);
  onCleanup(() => setSystemTime());
  const { host, reports } = await render();
  const later = new Date(Date.now() + 10 * 60_000);
  setSystemTime(later);
  // No pointer or key event: the route changes as the toolbar's Back would.
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-go]")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  await settleUntil(() => reports().some((r) => r.path === "/home"), "a report from /home");
  expect(Date.parse(reports().find((r) => r.path === "/home")!.lastInputAt!)).toBeGreaterThanOrEqual(later.getTime());
});

/** As the app's routes do: a canvas opened over a thread keeps the thread
 *  drawn behind it, under a location of its own. */
function OverCanvas() {
  const location = useLocation();
  const navigate = useNavigate();
  const behind = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation ?? null;
  return (
    <HistoryLocationContext.Provider value={location}>
      <Routes location={behind ?? location}>
        <Route path="*" element={<NotificationsClient toast={fakeToast().toast} />} />
      </Routes>
      <button type="button" data-open-canvas onClick={() => navigate("/canvas/cnv_x", { state: { backgroundLocation: location } })}>canvas</button>
    </HistoryLocationContext.Provider>
  );
}

test("a canvas opened over a thread is reported as the page shown, not the thread behind it", async () => {
  const calls = mockFetch(() => jsonResponse({ ok: true }));
  const { host } = await mountAsync(<MemoryRouter initialEntries={["/threads/thr_a"]}><OverCanvas /></MemoryRouter>);
  const reports = () => calls.filter((c) => c.url.endsWith("/api/notifications/presence")).map((c) => JSON.parse(String(c.init?.body)) as PresenceReport);
  await settleUntil(() => reports().length > 0, "the first report");
  expect(reports()[0]!.path).toBe("/threads/thr_a");
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-open-canvas]")!.click(); });
  await settleUntil(() => reports().some((r) => r.path === "/canvas/cnv_x"), "a report from the canvas");
});

test("a notice opened from a notification reports where it leads, not the page it leaves", async () => {
  FakeNotification.made = [];
  setFor(window, "Notification", FakeNotification);
  setFor(globalThis, "Notification", FakeNotification);
  setFor(window, "isSecureContext", true);
  const { reports } = await render({ path: "/home" });
  const windowId = reports()[0]!.windowId;
  await act(async () => { handleShow(show(windowId, { system: [windowId] })); });
  const before = reports().length;
  await act(async () => { FakeNotification.made[0]!.onclick!(); });
  await settleUntil(() => reports().length > before, "a report after the click");
  // New thread shows every thread's matter: reported from there, the click
  // would mark the others seen.
  expect(reports().slice(before).map((r) => r.path)).not.toContain("/home");
});

test("using a canvas inside its frame counts as touching the window", async () => {
  onCleanup(() => setSystemTime());
  const { reports } = await render();
  const later = new Date(Date.now() + 10 * 60_000);
  setSystemTime(later);
  const before = reports().length;
  await act(async () => { window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.interact", canvasId: "cnv_x" } })); });
  await settleUntil(() => reports().length > before, "a report after the canvas was used");
  expect(Date.parse(reports().at(-1)!.lastInputAt!)).toBeGreaterThanOrEqual(later.getTime());
});

test("a canvas reporting its own scroll position, as it does on load, is not the user touching it", async () => {
  onCleanup(() => setSystemTime());
  const { reports } = await render();
  const later = new Date(Date.now() + 10 * 60_000);
  setSystemTime(later);
  const before = reports().length;
  await act(async () => { window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.scroll", canvasId: "cnv_x", y: 0, height: 900 } })); });
  await settle(5);
  expect(reports().length).toBe(before);
});

test("typing into a form on Personal agent's page counts as touching the window", async () => {
  onCleanup(() => setSystemTime());
  const { reports } = await render({ path: "/agent" });
  const later = new Date(Date.now() + 10 * 60_000);
  setSystemTime(later);
  const before = reports().length;
  await act(async () => { window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.fields", values: { note: "a" } } })); });
  await settleUntil(() => reports().length > before, "a report after typing");
  expect(Date.parse(reports().at(-1)!.lastInputAt!)).toBeGreaterThanOrEqual(later.getTime());
});

// Where the user is, as the server reads it for what not to tell the
// personal agent: the thread whose chat this window has in sight.
test("the report names the thread whose chat is in sight, and is sent again when that changes", async () => {
  act(() => { useThreadChatInSight.setState({ threadId: "thr_a" }); });
  onCleanup(() => act(() => { useThreadChatInSight.setState({ threadId: null }); }));
  const { reports } = await render({ path: "/threads/thr_a" });
  expect(reports()[0]!.threadChat).toBe("thr_a");
  act(() => { useThreadChatInSight.setState({ threadId: null }); });
  await settleUntil(() => reports().length > 1, "a report after the chat went out of sight");
  expect("threadChat" in reports().at(-1)!).toBe(false);
});
