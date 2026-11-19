import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { AgentPagePane } from "@/routes/personal/page/AgentPagePane";
import { resetAgentPageStore } from "@/store/agent-page";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useStickyNotesStore } from "@/store/sticky-notes";
import { useThreadTabsStore } from "@/store/thread-tabs";
import { useClosedTabsStore } from "@/store/closed-tabs";
import { NOTES_TAB } from "@/lib/panel-tabs";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { stickyNoteDto } from "../helpers/client-builders.js";
import { resetStickyNotesStore } from "../helpers/sticky-notes.js";

// The sticky notes beside the personal agent: a Notes tab in its panel,
// opened from +, the wall the Notes page draws. A note counts as seen only
// once it is shown there, on a page in front.

const UI = { open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat" as const, tabs: [], active: "page", fileLines: {}, history: false, recent: [], tasksView: { query: "", showCancelled: false } };
afterEach(() => {
  runCleanups();
  resetAgentPageStore();
  resetStickyNotesStore();
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
  useAgentPageUi.setState(UI);
  useClosedTabsStore.setState({ byPanel: {} });
});

function serve(): FetchCall[] {
  const calls = mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse({ latest: null, write: null });
    if (path === "/api/agents/personal/thread-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agents/threads/thr_g/reply-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    if (path === "/api/sticky-notes/seen") return jsonResponse({ ok: true });
    return jsonResponse({}, 404);
  });
  act(() => {
    useStickyNotesStore.getState().replaceAll({
      open: [
        stickyNoteDto("note_a", { title: "The spike rule fired", kind: "alert", version: 3 }),
        stickyNoteDto("note_b", { title: "Docs merged", version: 2, seen: true }),
        stickyNoteDto("note_c", { title: "Keys rotated", kind: "check", version: 1 })
      ],
      done: []
    });
  });
  return calls;
}

const notesTab = (host: ParentNode) => host.querySelector<HTMLElement>('[data-notes-tab][role="tab"]');
const seenPosts = (calls: FetchCall[]) => calls.filter((c) => c.url.endsWith("/api/sticky-notes/seen")).map((c) => JSON.parse(String(c.init?.body)) as unknown);
const taped = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-slot="notes-panel"] [data-slot="sticky-note"][data-new]')].map((c) => c.dataset.noteId);

async function openAddMenu(host: HTMLElement) {
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Open a thread beside Juno"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

/** The page's browser tab in front or behind, as the browser says: set, then told. */
let browserTab: DocumentVisibilityState = "visible";
function visibility(state: DocumentVisibilityState) {
  if (!Object.getOwnPropertyDescriptor(document, "visibilityState")?.get?.name.startsWith("fakeVisibility")) {
    const own = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: function fakeVisibility() { return browserTab; } });
    onCleanup(() => {
      browserTab = "visible";
      if (own) Object.defineProperty(document, "visibilityState", own);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    });
  }
  browserTab = state;
  act(() => { document.dispatchEvent(new CustomEvent("visibilitychange")); });
}

test("+ opens a Notes tab after Tasks, counted while it is not in front; it shows the wall and closes like a thread tab", async () => {
  serve();
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  const items = await openAddMenu(host);
  expect(items.slice(0, 2).map((i) => i.textContent?.trim())).toEqual(["Tasks", "Notes2"]);
  await act(async () => { items[1]!.click(); });
  expect([notesTab(host)?.getAttribute("aria-selected"), useAgentPageUi.getState().active]).toEqual(["true", NOTES_TAB]);
  expect(host.querySelectorAll('[data-slot="notes-panel"] [data-slot="sticky-note"]').length).toBe(3);
  // Seen while in front (the server's answer); behind another tab, the tab says how many came since.
  act(() => {
    for (const id of ["note_a", "note_c"]) useStickyNotesStore.getState().upsert({ ...useStickyNotesStore.getState().open!.get(id)!, seen: true });
    useAgentPageUi.getState().setActive("page");
  });
  expect(notesTab(host)?.querySelector('[role="img"]') === null).toBe(true);
  act(() => { useStickyNotesStore.getState().upsert(stickyNoteDto("note_d", { title: "Certificate due", kind: "later", version: 4 })); });
  expect(notesTab(host)?.querySelector('[role="img"]')?.getAttribute("aria-label") ?? null).toBe("1 item to look at");
  await act(async () => { notesTab(host)!.querySelector<HTMLElement>('[aria-label="Close Notes"]')!.click(); });
  expect([notesTab(host) === null, useAgentPageUi.getState().active]).toEqual([true, "page"]);
});

test("notes shown in the tab are told as seen, each as shown, and keep their tape while the tab stays", async () => {
  const calls = serve();
  act(() => { useAgentPageUi.getState().openNotes(); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => seenPosts(calls).length === 1, "the look told");
  expect(seenPosts(calls)).toEqual([{ notes: [{ id: "note_a", version: 3 }, { id: "note_c", version: 1 }] }]);
  // The server's answer: seen. The tape stays while the tab is in front.
  act(() => {
    useStickyNotesStore.getState().upsert(stickyNoteDto("note_a", { title: "The spike rule fired", kind: "alert", version: 3, seen: true }));
    useStickyNotesStore.getState().upsert(stickyNoteDto("note_c", { title: "Keys rotated", kind: "check", version: 1, seen: true }));
  });
  expect(taped(host)).toEqual(["note_a", "note_c"]);
  // Left and come back to: no tape on what was seen.
  act(() => { useAgentPageUi.getState().setActive("page"); });
  act(() => { useAgentPageUi.getState().setActive(NOTES_TAB); });
  await settle();
  expect(taped(host)).toEqual([]);
  expect(seenPosts(calls).length).toBe(1);
});

test("nothing is told as seen while the tab is behind another, the panel is turned away, or the browser tab is in the back", async () => {
  const calls = serve();
  act(() => { useAgentPageUi.setState({ ...UI, tabs: [NOTES_TAB], active: "page" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settle(30);
  expect(seenPosts(calls).length).toBe(0);
  // A narrow row showing the chat.
  act(() => { useAgentPageUi.setState({ narrow: true, narrowView: "chat", active: NOTES_TAB }); });
  await settle(30);
  expect(seenPosts(calls).length).toBe(0);
  // In front again, but the browser tab is in the back.
  visibility("hidden");
  act(() => { useAgentPageUi.setState({ narrowView: "side" }); });
  await settle(30);
  expect(seenPosts(calls).length).toBe(0);
  visibility("visible");
  await settleUntil(() => seenPosts(calls).length === 1, "the look told once in sight");
  expect(host.querySelectorAll('[data-slot="notes-panel"] [data-slot="sticky-note"]').length).toBe(3);
});

test("a look that failed to reach the server is told again once the notes come anew, the tape kept meanwhile", async () => {
  let fail = true;
  const calls = mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/sticky-notes/seen") return fail ? jsonResponse({ error: "down" }, 502) : jsonResponse({ ok: true });
    if (path === "/api/agent-page") return jsonResponse({ latest: null, write: null });
    if (path === "/api/agents/personal/thread-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agents/threads/thr_g/reply-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    return jsonResponse({}, 404);
  });
  const notes = [stickyNoteDto("note_a", { kind: "alert", version: 3 })];
  act(() => { useStickyNotesStore.getState().replaceAll({ open: notes, done: [] }); useAgentPageUi.getState().openNotes(); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => seenPosts(calls).length === 1, "the first look");
  await settle(20);
  fail = false;
  // The stream comes back: the same notes, still unseen.
  act(() => { useStickyNotesStore.getState().replaceAll({ open: [stickyNoteDto("note_a", { kind: "alert", version: 3 })], done: [] }); });
  await settleUntil(() => seenPosts(calls).length === 2, "the look told again");
  expect(taped(host)).toEqual(["note_a"]);
});

test("a wall the browser does not show (its side hidden) tells no look", async () => {
  const calls = serve();
  const own = Object.getOwnPropertyDescriptor(Element.prototype, "checkVisibility");
  Object.defineProperty(Element.prototype, "checkVisibility", { configurable: true, writable: true, value() { return false; } });
  onCleanup(() => {
    if (own) Object.defineProperty(Element.prototype, "checkVisibility", own);
    else delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
  });
  act(() => { useAgentPageUi.getState().openNotes(); });
  await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" });
  await settle(60);
  expect(seenPosts(calls).length).toBe(0);
});
