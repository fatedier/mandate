import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { StickyNoteRefusal, StickyNotesService } from "../src/server/modules/sticky-notes/sticky-notes-service.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function service(opts: { titles?: Record<string, string> } = {}) {
  env = freshStoresEnv("md-sticky-");
  let clock = Date.parse("2026-03-04T05:06:00Z");
  const emitted: Array<{ event: string; id: string; doneAt: string | null }> = [];
  const notes = new StickyNotesService({
    db: env.store.db,
    sse: { emit: (event: string, data: { note: { id: string; doneAt: string | null } }) => { emitted.push({ event, id: data.note.id, doneAt: data.note.doneAt }); } } as never,
    about: (ref) => opts.titles?.[ref.id] ?? null,
    now: () => clock
  });
  return { notes, emitted, tick: (ms = 60_000) => { clock += ms; } };
}

const sample = { title: "The spike rule fired", body: "40 failed orders in an hour.", kind: "alert" as const };

function refusal(run: () => unknown): { message: string; status: number } | null {
  try {
    run();
    return null;
  } catch (err) {
    return err instanceof StickyNoteRefusal ? { message: err.message, status: err.status } : null;
  }
}

test("a note the agent adds is open and new, and seen once marked so", () => {
  const { notes } = service();
  const note = notes.add(sample);
  expect(note.id).toMatch(/^note_[A-Za-z0-9_-]{11}$/);
  expect(notes.open().map((n) => [n.id, n.seen])).toEqual([[note.id, false]]);
  notes.markSeen([{ id: note.id, version: note.version }]);
  expect(notes.open()[0]!.seen).toBe(true);
  expect(notes.list().done.length).toBe(0);
});

test("an update replaces what it gives, makes the note new again and lifts it to the top", () => {
  const { notes, tick } = service();
  const first = notes.add(sample);
  tick();
  const second = notes.add({ ...sample, title: "Docs merged", kind: "fyi" });
  notes.markSeen([first, second]);
  tick();
  const updated = notes.update(first.id, { kind: "fyi", body: "Back to normal." });
  expect([updated.title, updated.body, updated.kind, updated.seen]).toEqual(["The spike rule fired", "Back to normal.", "fyi", false]);
  expect(updated.updatedAt > updated.createdAt).toBe(true);
  expect(notes.open().map((n) => n.id)).toEqual([first.id, second.id]);
});

test("the agent removes a note with a reason, and the user finishes and restores one", () => {
  const { notes } = service();
  const a = notes.add(sample);
  const b = notes.add({ ...sample, title: "Check the release notes", kind: "check" });
  const removed = notes.remove(a.id, "  They answered it in chat. ");
  expect([removed.doneBy, removed.reason, removed.doneAt !== null]).toEqual(["agent", "They answered it in chat.", true]);
  const done = notes.done(b.id);
  expect([done.doneBy, done.reason]).toEqual(["user", null]);
  expect(notes.open().length).toBe(0);
  expect(notes.list().done.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
  const back = notes.restore(a.id);
  expect([back.doneAt, back.doneBy, back.reason, back.seen]).toEqual([null, null, null, true]);
  expect(notes.open().map((n) => n.id)).toEqual([a.id]);
});

test("a done or unknown note cannot be updated or removed, and a removal needs a reason", () => {
  const { notes } = service();
  const a = notes.add(sample);
  expect(refusal(() => notes.remove(a.id, "   "))).toEqual({ message: "Say in a few words why it goes: the user sees it.", status: 400 });
  notes.done(a.id);
  expect(refusal(() => notes.update(a.id, { body: "x" }))).toEqual({ message: "No open note with that id.", status: 404 });
  expect(refusal(() => notes.remove(a.id, "gone"))).toEqual({ message: "No open note with that id.", status: 404 });
  expect(refusal(() => notes.update("note_missingmissin", { body: "x" }))).toEqual({ message: "No open note with that id.", status: 404 });
  expect(refusal(() => notes.done("note_missingmissin"))?.status).toBe(404);
});

test("a note needs a title, a body and a kind, and long words are cut to the limits", () => {
  const { notes } = service();
  expect(refusal(() => notes.add({ ...sample, title: "  " }))).toEqual({ message: "A note needs a title, a body and a kind.", status: 400 });
  expect(refusal(() => notes.add({ ...sample, body: "" }))?.message).toBe("A note needs a title, a body and a kind.");
  expect(refusal(() => notes.add({ ...sample, kind: "urgent" as never }))?.message).toBe("A note needs a title, a body and a kind.");
  const long = notes.add({ title: "题".repeat(300), body: "文".repeat(2000), kind: "later" });
  expect([long.title.length, long.body.length]).toEqual([120, 800]);
  const removed = notes.remove(long.id, "因".repeat(500));
  expect(removed.reason!.length).toBe(200);
});

test("the Done list holds the newest 50", () => {
  const { notes, tick } = service();
  const ids: string[] = [];
  for (let n = 0; n < 53; n += 1) {
    const note = notes.add({ ...sample, title: `Note ${n}` });
    tick();
    notes.done(note.id);
    ids.push(note.id);
  }
  const done = notes.list().done.map((n) => n.id);
  expect(done.length).toBe(50);
  expect(done[0]).toBe(ids[52]!);
  expect(done.includes(ids[0]!)).toBe(false);
});

test("what a note is about reads as it is now, or as it was when the thread or task is gone", () => {
  const { notes } = service({ titles: { thr_renamed: "Oven temperature watch" } });
  const live = notes.add({ ...sample, threadId: "thr_renamed", aboutTitle: "Old title" });
  const gone = notes.add({ ...sample, taskId: "tsk_gone", aboutTitle: "Rotate staging keys" });
  const none = notes.add(sample);
  expect(live.about).toEqual({ kind: "thread", id: "thr_renamed", title: "Oven temperature watch" });
  expect(gone.about).toEqual({ kind: "task", id: "tsk_gone", title: "Rotate staging keys" });
  expect(none.about).toBe(null);
});

test("each write is told once, after it lands", () => {
  const { notes, emitted } = service();
  const a = notes.add(sample);
  notes.markSeen([a]);
  notes.update(a.id, { title: "Changed" });
  notes.done(a.id);
  notes.restore(a.id);
  expect(emitted.map((e) => e.event)).toEqual(Array(5).fill(SSE_EVENTS.stickyNoteUpdated));
  expect(emitted.map((e) => e.doneAt !== null)).toEqual([false, false, false, true, false]);
  // Marking seen what is seen already tells nothing.
  notes.markSeen([notes.get(a.id)!]);
  notes.markSeen([{ id: "note_missingmissin", version: a.version }]);
  expect(emitted.length).toBe(5);
});

test("the notes done by the user since a time are listed, newest first, without the agent's removals", () => {
  const { notes, tick } = service();
  const a = notes.add(sample);
  const b = notes.add(sample);
  const c = notes.add(sample);
  notes.done(a.id);
  tick();
  const since = Date.parse("2026-03-04T05:06:30Z");
  notes.done(b.id);
  notes.remove(c.id, "resolved");
  expect(notes.doneSince(since).map((n) => n.id)).toEqual([b.id]);
});

test("an update right after a look, in the same millisecond, is still new", () => {
  const { notes } = service();
  const note = notes.add(sample);
  notes.markSeen([note]);
  expect(notes.update(note.id, { body: "Changed at once." }).seen).toBe(false);
});

test("a look at an older version leaves a newer one new", () => {
  const { notes } = service();
  const note = notes.add(sample);
  const shown = note.version;
  notes.update(note.id, { body: "Changed after the look, in the same millisecond." });
  notes.markSeen([{ id: note.id, version: shown }]);
  expect(notes.get(note.id)!.seen).toBe(false);
  notes.markSeen([{ id: note.id, version: notes.get(note.id)!.version }]);
  expect(notes.get(note.id)!.seen).toBe(true);
});

test("what a note is about keeps the name it had when written, though none was given", () => {
  const titles: Record<string, string> = { thr_live: "Release notes" };
  env = freshStoresEnv("md-sticky-about-");
  const notes = new StickyNotesService({ db: env.store.db, sse: { emit: () => {} } as never, about: (ref) => titles[ref.id] ?? null });
  const note = notes.add({ ...sample, threadId: "thr_live" });
  delete titles.thr_live;
  expect(notes.get(note.id)!.about).toEqual({ kind: "thread", id: "thr_live", title: "Release notes" });
  // Naming the same thread again keeps that name; naming none clears it.
  titles.thr_live = "Release notes 2.4";
  expect(notes.update(note.id, { threadId: "thr_live" }).about!.title).toBe("Release notes 2.4");
  delete titles.thr_live;
  expect(notes.get(note.id)!.about!.title).toBe("Release notes 2.4");
  expect(notes.update(note.id, { threadId: null, taskId: null }).about).toBe(null);
});

test("changes in one millisecond keep their order: the last changed is on top", () => {
  const { notes } = service();
  const a = notes.add(sample);
  const b = notes.add({ ...sample, title: "B" });
  notes.update(a.id, { body: "A changed last." });
  expect(notes.open().map((n) => n.id)).toEqual([a.id, b.id]);
  notes.done(a.id);
  notes.done(b.id);
  expect(notes.list().done.map((n) => n.id)).toEqual([b.id, a.id]);
});

test("naming a thread that is gone again keeps the name it had; naming only no thread keeps the task", () => {
  const titles: Record<string, string> = { thr_gone: "Oven temperature watch", tsk_kept: "Rotate staging keys" };
  env = freshStoresEnv("md-sticky-about2-");
  const notes = new StickyNotesService({ db: env.store.db, sse: { emit: () => {} } as never, about: (ref) => titles[ref.id] ?? null });
  const a = notes.add({ ...sample, threadId: "thr_gone" });
  delete titles.thr_gone;
  expect(notes.update(a.id, { threadId: "thr_gone", body: "Again." }).about).toEqual({ kind: "thread", id: "thr_gone", title: "Oven temperature watch" });
  const b = notes.add({ ...sample, taskId: "tsk_kept" });
  expect(notes.update(b.id, { threadId: null, body: "Changed." }).about).toEqual({ kind: "task", id: "tsk_kept", title: "Rotate staging keys" });
});

test("versions rise with every change but a look, and the wall is ordered by them", () => {
  const { notes } = service();
  const a = notes.add(sample);
  const b = notes.add(sample);
  expect(b.version > a.version).toBe(true);
  notes.markSeen([b]);
  expect(notes.get(b.id)!.version).toBe(b.version);
  expect(notes.update(a.id, { body: "x" }).version > b.version).toBe(true);
});
