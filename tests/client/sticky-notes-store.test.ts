import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { SSE_EVENTS } from "@shared/api-contracts";
import { attachSnapshotSseListeners } from "@/lib/snapshot-sse-listeners";
import { useStickyNotesStore } from "@/store/sticky-notes";
import { resetStickyNotesStore } from "../helpers/sticky-notes.js";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { stickyNoteDto } from "../helpers/client-builders.js";

// The client's copy of the agent's sticky notes: filled and kept by the
// stream, finished and restored through the user's routes.

afterEach(() => {
  runCleanups();
  resetStickyNotesStore();
});

function stream(): EventSource {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection() {}, onReconnect() {} });
  return source;
}
const send = (source: EventSource, type: string, data: unknown) => source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
const openIds = () => useStickyNotesStore.getState().openList().map((n) => n.id);
const doneIds = () => useStickyNotesStore.getState().doneList().map((n) => n.id);

test("the stream fills the notes, and each change lands on the wall or in Done, last changed first", () => {
  const source = stream();
  expect(useStickyNotesStore.getState().open).toBe(null);
  send(source, SSE_EVENTS.stickyNotes, { open: [stickyNoteDto("note_b", { version: 2 }), stickyNoteDto("note_a", { version: 1 })], done: [stickyNoteDto("note_d", { version: 3, doneAt: "2026-11-01T10:00:00.000Z", doneBy: "user" })] });
  expect([openIds(), doneIds()]).toEqual([["note_b", "note_a"], ["note_d"]]);
  // An update rises to the top; a look changes nothing of the order.
  send(source, SSE_EVENTS.stickyNoteUpdated, { note: stickyNoteDto("note_a", { version: 4, title: "Changed" }) });
  expect(openIds()).toEqual(["note_a", "note_b"]);
  send(source, SSE_EVENTS.stickyNoteUpdated, { note: stickyNoteDto("note_b", { version: 2, seen: true }) });
  expect([openIds(), useStickyNotesStore.getState().open!.get("note_b")!.seen]).toEqual([["note_a", "note_b"], true]);
  // Done moves it across; a restore moves it back.
  send(source, SSE_EVENTS.stickyNoteUpdated, { note: stickyNoteDto("note_a", { version: 5, doneAt: "2026-11-01T11:00:00.000Z", doneBy: "agent", reason: "resolved" }) });
  expect([openIds(), doneIds()]).toEqual([["note_b"], ["note_a", "note_d"]]);
  send(source, SSE_EVENTS.stickyNoteUpdated, { note: stickyNoteDto("note_a", { version: 6, seen: true }) });
  expect([openIds(), doneIds()]).toEqual([["note_a", "note_b"], ["note_d"]]);
  // An older copy arriving late does not undo a newer one.
  send(source, SSE_EVENTS.stickyNoteUpdated, { note: stickyNoteDto("note_a", { version: 5, doneAt: "2026-11-01T11:00:00.000Z", doneBy: "agent" }) });
  expect(openIds()).toEqual(["note_a", "note_b"]);
});

test("the Done list keeps the newest 50", () => {
  const source = stream();
  const done = Array.from({ length: 50 }, (_, n) => stickyNoteDto(`note_${n}`, { version: n + 1, doneAt: "2026-11-01T10:00:00.000Z", doneBy: "user" }));
  send(source, SSE_EVENTS.stickyNotes, { open: [stickyNoteDto("note_x", { version: 100 })], done });
  send(source, SSE_EVENTS.stickyNoteUpdated, { note: stickyNoteDto("note_x", { version: 101, doneAt: "2026-11-01T12:00:00.000Z", doneBy: "user" }) });
  expect([doneIds().length, doneIds()[0], doneIds().includes("note_0")]).toEqual([50, "note_x", false]);
});

test("Done and Restore go through the user's routes and put the answer in", async () => {
  const source = stream();
  send(source, SSE_EVENTS.stickyNotes, { open: [stickyNoteDto("note_a")], done: [] });
  const calls: string[] = [];
  mockFetch(({ url, method }) => {
    calls.push(`${method} ${url}`);
    const done = url.endsWith("/done");
    return jsonResponse({ note: stickyNoteDto("note_a", { version: done ? 2 : 3, doneAt: done ? "2026-11-01T10:00:00.000Z" : null, doneBy: done ? "user" : null, seen: true }) });
  });
  await act(async () => { await useStickyNotesStore.getState().markDone("note_a"); });
  expect([openIds(), doneIds()]).toEqual([[], ["note_a"]]);
  await act(async () => { await useStickyNotesStore.getState().restore("note_a"); });
  expect([openIds(), doneIds()]).toEqual([["note_a"], []]);
  expect(calls).toEqual(["POST /api/sticky-notes/note_a/done", "POST /api/sticky-notes/note_a/restore"]);
});

test("what was shown is told as it was shown", async () => {
  const bodies: unknown[] = [];
  mockFetch(({ init }) => { bodies.push(JSON.parse(String(init?.body))); return jsonResponse({ ok: true }); });
  await act(async () => { await useStickyNotesStore.getState().markSeen([stickyNoteDto("note_a", { version: 7 })]); });
  expect(bodies).toEqual([{ notes: [{ id: "note_a", version: 7 }] }]);
});

test("a snapshot older than what is held does not undo it", () => {
  const source = stream();
  send(source, SSE_EVENTS.stickyNoteUpdated, { note: stickyNoteDto("note_a", { version: 2, doneAt: "2026-11-01T10:00:00.000Z", doneBy: "user" }) });
  // A reconnect's snapshot, read before that change landed.
  send(source, SSE_EVENTS.stickyNotes, { open: [stickyNoteDto("note_a", { version: 1 }), stickyNoteDto("note_b", { version: 1 })], done: [] });
  expect([openIds(), doneIds()]).toEqual([["note_b"], ["note_a"]]);
});

test("a note restored out of a full Done list has the list filled again from the server", async () => {
  const source = stream();
  const done = Array.from({ length: 51 }, (_, n) => stickyNoteDto(`note_${n}`, { version: n + 1, doneAt: "2026-11-01T10:00:00.000Z", doneBy: "user" }));
  send(source, SSE_EVENTS.stickyNotes, { open: [], done: done.slice(1).reverse() });
  const calls = mockFetch(() => jsonResponse({ open: [stickyNoteDto("note_50", { version: 60, seen: true })], done: done.slice(0, 50).reverse() }));
  await act(async () => {
    send(source, SSE_EVENTS.stickyNoteUpdated, { note: stickyNoteDto("note_50", { version: 60, seen: true }) });
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/sticky-notes"]);
  expect([doneIds().length, doneIds().includes("note_0"), openIds()]).toEqual([50, true, ["note_50"]]);
});
