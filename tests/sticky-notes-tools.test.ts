import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { StickyNotesService } from "../src/server/modules/sticky-notes/sticky-notes-service.js";
import { buildStickyNotesTools } from "../src/server/modules/sticky-notes/tools/sticky-notes-tools.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup() {
  env = freshStoresEnv("md-sticky-tool-");
  const e = env;
  const taskBoard = new TaskBoardService({ db: e.store.db, agentStore: e.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map() });
  const notes = new StickyNotesService({
    db: e.store.db, sse: { emit: () => {} } as never,
    about: (ref) => (ref.kind === "thread" ? e.agentStore.getThreadById(ref.id)?.title ?? null : taskBoard.detail(ref.id)?.title ?? null)
  });
  const tool = buildStickyNotesTools({ stickyNotes: notes, agentStore: e.agentStore, taskBoard, timeZone: () => "UTC" })[0]!;
  const personal = e.agentStore.getOrCreatePersonalThread();
  const call = (args: Record<string, unknown>, wakeId = "w1") => tool.handler(args as never, toolContext({ threadId: personal.id, wakeId }));
  return { e, notes, tool, call, taskBoard, personal };
}

const idIn = (out: unknown): string => /`(note_[A-Za-z0-9_-]{11})`/.exec(String(out))?.[1] ?? "";

test("there is one tool, sticky_notes, described in its fixed words", () => {
  const { tool } = setup();
  expect(tool.name).toBe("sticky_notes");
  expect(tool.description.startsWith("Sticky notes on the user's Notes page: what they must not miss")).toBe(true);
});

test("add writes the note about the thread named", async () => {
  const { e, notes, call } = setup();
  const thread = e.agentStore.createManagerThread("Oven temperature watch");
  const out = await call({ action: "add", title: "The spike rule fired", body: "40 failed orders between 09:00 and 10:00.", kind: "alert", threadId: thread.id, noteId: "", reason: "", taskId: "" });
  const [note] = notes.open();
  expect(idIn(out)).toBe(note!.id);
  expect(note!.about).toEqual({ kind: "thread", id: thread.id, title: "Oven temperature watch" });
  expect(String(out)).toContain('thread "Oven temperature watch"');
});

test("a note about a task names the task", async () => {
  const { notes, call, taskBoard } = setup();
  const task = taskBoard.create({ title: "Rotate staging keys" }, "owner");
  await call({ action: "add", title: "Keys rotated", body: "Check the new keys.", kind: "check", taskId: task.id });
  expect(notes.open()[0]!.about).toEqual({ kind: "task", id: task.id, title: "Rotate staging keys" });
});

test("a note needs a title, a body and a kind; an unknown thread or task is refused", async () => {
  const { notes, call } = setup();
  expect(await call({ action: "add", title: "", body: "x", kind: "fyi" })).toEqual({ error: "A note needs a title, a body and a kind." });
  expect(await call({ action: "add", title: "t", body: "x" })).toEqual({ error: "A note needs a title, a body and a kind." });
  expect(await call({ action: "add", title: "t", body: "x", kind: "fyi", threadId: "thr_missingmiss" })).toEqual({ error: "No such thread: thr_missingmiss." });
  expect(await call({ action: "add", title: "t", body: "x", kind: "fyi", taskId: "tsk_missingmiss" })).toEqual({ error: "No such task: tsk_missingmiss." });
  expect(notes.open().length).toBe(0);
});

test("update replaces only what it gives, and the note is new again", async () => {
  const { notes, call } = setup();
  const id = idIn(await call({ action: "add", title: "The spike rule fired", body: "40 failed orders.", kind: "alert" }));
  notes.markSeen([notes.get(id)!]);
  const out = await call({ action: "update", noteId: id, kind: "fyi", body: "Back to normal since 10:00.", title: "" });
  const note = notes.get(id)!;
  expect([note.title, note.body, note.kind, note.seen]).toEqual(["The spike rule fired", "Back to normal since 10:00.", "fyi", false]);
  expect(idIn(out)).toBe(id);
});

test("update or remove of a note that is done or unknown is refused, and remove needs a reason", async () => {
  const { notes, call } = setup();
  const id = idIn(await call({ action: "add", title: "Docs merged", body: "Two docs went in.", kind: "fyi" }));
  expect(await call({ action: "remove", noteId: id, reason: "  " })).toEqual({ error: "Say in a few words why it goes: the user sees it." });
  const out = await call({ action: "remove", noteId: id, reason: "They read it here." });
  expect(idIn(out)).toBe(id);
  expect(notes.get(id)!.doneBy).toBe("agent");
  expect(await call({ action: "update", noteId: id, body: "x" })).toEqual({ error: "No open note with that id." });
  expect(await call({ action: "remove", noteId: id, reason: "again" })).toEqual({ error: "No open note with that id." });
  expect(await call({ action: "update", noteId: "", body: "x" })).toEqual({ error: "No open note with that id." });
});

test("an update that names the note's own subject again goes through, though that task is gone since", async () => {
  const { notes, call, taskBoard } = setup();
  const task = taskBoard.create({ title: "Rotate staging keys" }, "owner");
  const id = idIn(await call({ action: "add", title: "Keys rotated", body: "Check the new keys.", kind: "check", taskId: task.id }));
  taskBoard.remove(task.id);
  const out = await call({ action: "update", noteId: id, taskId: task.id, body: "Old keys deleted." });
  expect(idIn(out)).toBe(id);
  expect([notes.get(id)!.body, notes.get(id)!.about]).toEqual(["Old keys deleted.", { kind: "task", id: task.id, title: "Rotate staging keys" }]);
  // Another task that is gone is still refused.
  expect(await call({ action: "update", noteId: id, taskId: "tsk_missingmiss" })).toEqual({ error: "No such task: tsk_missingmiss." });
});

test("an update of a done note says so first, whatever else it names", async () => {
  const { call } = setup();
  const id = idIn(await call({ action: "add", title: "Docs merged", body: "Two docs went in.", kind: "fyi" }));
  await call({ action: "remove", noteId: id, reason: "read" });
  expect(await call({ action: "update", noteId: id, threadId: "thr_missingmiss", body: "x" })).toEqual({ error: "No open note with that id." });
});
