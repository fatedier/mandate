import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { NotesPage } from "@/routes/sticky-notes/NotesPage";
import { NotesNavRow } from "@/shell/NotesNavRow";
import { MobileNav } from "@/shell/MobileNav";
import { useStickyNotesStore } from "@/store/sticky-notes";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useTaskBoardStore } from "@/store/task-board";
import { resetTaskBoardStore } from "../helpers/task-board.js";
import type { StickyNoteDto } from "@shared/api/sticky-notes";
import { resetStickyNotesStore } from "../helpers/sticky-notes.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settleUntil } from "../helpers/mount.js";
import { managerThreadDto, stickyNoteDto, taskDto } from "../helpers/client-builders.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { fakeClock } from "../helpers/fake-clock.js";

// The Notes page: the agent's sticky notes as a wall of paper, finished and
// restored there, counted on the sidebar.

afterEach(() => {
  runCleanups();
  resetStickyNotesStore();
  act(() => { usePersonalAgentStore.setState({ agent: null }); });
});

/** Today (or `daysAgo` days back) at this local time, as the server writes it. */
function at(hour: number, minute: number, daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function render(open: StickyNoteDto[], done: StickyNoteDto[] = [], answer: (call: FetchCall) => Response = () => jsonResponse({ ok: true })) {
  const calls = mockFetch((call) => answer(call));
  act(() => {
    useStickyNotesStore.getState().replaceAll({ open, done });
    usePersonalAgentStore.setState({ agent: { threadId: "thr_g", name: "Juno", named: true } as never });
  });
  const host = mount(
    <MemoryRouter initialEntries={["/notes"]}>
      <Routes>
        <Route path="/notes" element={<NotesPage />} />
              </Routes>
    </MemoryRouter>
  ).host;
  return { host, calls };
}

const cards = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-slot="sticky-note"]')];
const text = (el: ParentNode | null, slot: string) => el?.querySelector(`[data-slot="${slot}"]`)?.textContent?.trim() ?? null;
const named = (el: ParentNode, name: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
/** The user's Done and Restore, not the looks the page tells of. */
const posts = (calls: FetchCall[]) => calls.filter((c) => c.method === "POST" && !c.url.endsWith("/seen")).map((c) => c.url);

const three = () => [
  stickyNoteDto("note_alert", { kind: "alert", title: "The frost alert fired", body: "Twelve readings below zero, **one** bed.", version: 3, createdAt: at(15, 6), updatedAt: at(15, 6), about: { kind: "thread", id: "thr_p", title: "Greenhouse frost watch" } }),
  stickyNoteDto("note_check", { kind: "check", title: "Keys rotated", version: 2, createdAt: at(9, 0), updatedAt: at(15, 40), about: { kind: "task", id: "tsk_k", title: "Rotate staging keys" } }),
  stickyNoteDto("note_fyi", { kind: "fyi", title: "Docs merged", version: 1, createdAt: at(4, 27, 1), updatedAt: at(4, 27, 1), seen: true })
];

test("the wall shows each note as paper of its kind, newest change first, with what it is about and when", () => {
  const { host } = render(three());
  expect([text(host, "notes-count"), text(host, "notes-new")]).toEqual(["3 notes", "· 2 new"]);
  const wall = cards(host);
  expect(wall.map((c) => [c.dataset.kind, c.hasAttribute("data-new")])).toEqual([["alert", true], ["check", true], ["fyi", false]]);
  expect(wall.map((c) => text(c, "sticky-note-kind"))).toEqual(["Alert", "To check", "FYI"]);
  expect(wall.map((c) => text(c, "sticky-note-title"))).toEqual(["The frost alert fired", "Keys rotated", "Docs merged"]);
  const clock = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  expect(wall.map((c) => [text(c, "sticky-note-source"), text(c, "sticky-note-when")])).toEqual([
    ["Greenhouse frost watch", clock(at(15, 6))],
    ["Rotate staging keys", `Updated ${clock(at(15, 40))}`],
    ["Juno", `Yesterday ${clock(at(4, 27, 1))}`]
  ]);
  // The body is Markdown, cut at five lines.
  const body = wall[0]!.querySelector('[data-slot="sticky-note-body"]')!;
  expect([body.querySelector("strong")?.textContent ?? null, body.className.includes("line-clamp-5")]).toEqual(["one", true]);
});

test("a note from further back is dated, and the wall says when there are none", () => {
  const { host } = render([stickyNoteDto("note_old", { createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-05T10:00:00.000Z", seen: true })]);
  expect(/^Jan 5(, 2026)?$/.test(text(cards(host)[0]!, "sticky-note-when") ?? "")).toBe(true);
  expect(text(host, "notes-new")).toBe(null);
  act(() => { useStickyNotesStore.getState().replaceAll({ open: [], done: [] }); });
  expect([text(host, "notes-count"), cards(host).length]).toEqual(["No notes.", 0]);
});

test("Done takes a note off the wall; Show done lists it and the agent's removals, and Restore brings one back", async () => {
  const removed = stickyNoteDto("note_gone", { title: "Old alarm", version: 9, doneAt: at(15, 22), doneBy: "agent", reason: "you answered it in chat." });
  const { host, calls } = render(three(), [removed], (call) => {
    const id = call.url.split("/")[3]!;
    const note = three().find((n) => n.id === id) ?? removed;
    return call.url.endsWith("/done")
      ? jsonResponse({ note: { ...note, version: 10, doneAt: at(15, 20), doneBy: "user" } })
      : jsonResponse({ note: { ...note, version: 11, doneAt: null, doneBy: null, reason: null, seen: true } });
  });
  await act(async () => { named(cards(host)[0]!, "Done")!.click(); });
  await settleUntil(() => cards(host).length === 2, "the note taken off the wall");
  expect(posts(calls)).toEqual(["/api/sticky-notes/note_alert/done"]);
  act(() => { named(host, "Show done (2)")!.click(); });
  const clock = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-slot="sticky-note-done-row"]')];
  expect(rows().map((r) => [text(r, "sticky-note-done-title"), text(r, "sticky-note-done-when")])).toEqual([
    ["The frost alert fired", `Done ${clock(at(15, 20))}`],
    ["Old alarm", `Removed by Juno ${clock(at(15, 22))}: you answered it in chat.`]
  ]);
  await act(async () => { named(rows()[1]!, "Restore")!.click(); });
  await settleUntil(() => cards(host).length === 3, "the note back on the wall");
  expect(posts(calls)[1]).toBe("/api/sticky-notes/note_gone/restore");
  expect(named(host, "Hide done") !== undefined).toBe(true);
  act(() => { named(host, "Hide done")!.click(); });
  expect([rows().length, named(host, "Show done (1)") !== undefined]).toEqual([0, true]);
});

test("the sidebar's Notes counts the notes not seen yet, and nothing when all are", () => {
  act(() => { useStickyNotesStore.getState().replaceAll({ open: three(), done: [] }); });
  const host = mount(<NotesNavRow current={false} />, { path: "/home" }).host;
  const link = host.querySelector<HTMLAnchorElement>('a[data-slot="notes-nav"]')!;
  expect([link.getAttribute("href"), link.textContent?.trim().startsWith("Notes"), link.querySelector('[role="img"]')?.getAttribute("aria-label") ?? null]).toEqual(["/notes", true, "2 items to look at"]);
  act(() => { useStickyNotesStore.getState().replaceAll({ open: three().map((n) => ({ ...n, seen: true })), done: [] }); });
  expect(link.querySelector('[role="img"]') === null).toBe(true);
});

test("the phone's drawer reaches Notes", () => {
  onCleanup(fakePhoneWidth(390));
  const host = mount(<MobileNav />, { path: "/agent" }).host;
  act(() => { host.querySelector<HTMLElement>('[aria-label="Open navigation"]')!.click(); });
  const link = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.trim().startsWith("Notes"));
  expect(link?.getAttribute("href")).toBe("/notes");
});

test("the times follow the clock past midnight", async () => {
  fakeClock();
  jest.setSystemTime(new Date(2026, 10, 12, 23, 59, 0));
  const note = stickyNoteDto("note_late", { createdAt: new Date(2026, 10, 12, 23, 0).toISOString(), updatedAt: new Date(2026, 10, 12, 23, 0).toISOString() });
  const { host } = render([note]);
  expect(text(cards(host)[0]!, "sticky-note-when")).toBe("23:00");
  await act(async () => {
    jest.setSystemTime(new Date(2026, 10, 13, 0, 1, 0));
    jest.advanceTimersByTime(16_000);
    await Promise.resolve();
  });
  expect(text(cards(host)[0]!, "sticky-note-when")).toBe("Yesterday 23:00");
});

test("a card names its thread or task as it is called now, and the note's own copy once it is gone", () => {
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map([["thr_p", managerThreadDto("thr_p", { title: "Greenhouse frost, north beds" })]]) });
    useTaskBoardStore.getState().replaceAll([taskDto("tsk_k", { title: "Rotate staging keys and certs" })]);
  });
  onCleanup(() => act(() => { useManagerThreadsStore.setState({ threads: new Map() }); resetTaskBoardStore(); }));
  const notes = [...three(), stickyNoteDto("note_gone", { version: 0, about: { kind: "thread", id: "thr_gone", title: "An old thread" } })];
  const { host } = render(notes);
  expect(cards(host).map((c) => text(c, "sticky-note-source"))).toEqual(["Greenhouse frost, north beds", "Rotate staging keys and certs", "Juno", "An old thread"]);
  // A long title reads whole on hover.
  expect(cards(host)[0]!.querySelector('[data-slot="sticky-note-title"]')?.getAttribute("title")).toBe("The frost alert fired");
});

/** The body's box as a browser would measure it: taller than its five lines, or not. */
function bodyOverflows(overflowing: (el: HTMLElement) => boolean) {
  for (const [name, pick] of [["scrollHeight", (el: HTMLElement) => (overflowing(el) ? 400 : 100)], ["clientHeight", () => 100]] as const) {
    // On the prototype that holds the getter (happy-dom has them on different ones), put back as it was.
    let holder: object | null = HTMLElement.prototype;
    while (holder && !Object.getOwnPropertyDescriptor(holder, name)) holder = Object.getPrototypeOf(holder) as object | null;
    const target = holder ?? HTMLElement.prototype;
    const own = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, get(this: HTMLElement) { return this.dataset?.slot === "sticky-note-body" ? pick(this) : own?.get?.call(this) ?? 0; } });
    onCleanup(() => {
      if (own) Object.defineProperty(target, name, own);
      else delete (target as unknown as Record<string, unknown>)[name];
    });
  }
}

test("a body longer than its five lines opens with More and closes with Less; a short one has neither", async () => {
  bodyOverflows((el) => el.closest<HTMLElement>('[data-slot="sticky-note"]')?.dataset.noteId === "note_long");
  const { host } = render([stickyNoteDto("note_long", { body: "A long body.", version: 2 }), stickyNoteDto("note_short", { body: "Short.", version: 1 })]);
  const long = () => cards(host).find((c) => c.dataset.noteId === "note_long")!;
  const short = () => cards(host).find((c) => c.dataset.noteId === "note_short")!;
  await settleUntil(() => named(long(), "More") !== undefined, "More under the long body");
  expect(named(short(), "More") === undefined).toBe(true);
  const body = () => long().querySelector<HTMLElement>('[data-slot="sticky-note-body"]')!;
  expect(body().className.includes("line-clamp-5")).toBe(true);
  act(() => { named(long(), "More")!.click(); });
  expect([body().className.includes("line-clamp-5"), named(long(), "Less")?.getAttribute("aria-expanded") ?? null]).toEqual([false, "true"]);
  act(() => { named(long(), "Less")!.click(); });
  expect([body().className.includes("line-clamp-5"), named(long(), "More")?.getAttribute("aria-expanded") ?? null]).toEqual([true, "false"]);
});
