import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { getJson, postJson } from "./helpers/test-app.js";
import { stickyNotesModule } from "../src/server/modules/sticky-notes/module.js";
import { StickyNotesService } from "../src/server/modules/sticky-notes/sticky-notes-service.js";
import type { AppDeps } from "../src/server/app/deps.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function app() {
  env = freshStoresEnv("md-sticky-routes-");
  const stickyNotes = new StickyNotesService({ db: env.store.db, sse: { emit: () => {} } as never, about: () => null });
  const hono = new Hono();
  stickyNotesModule.mountRoutes!(hono, { deps: { stickyNotes } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  return { hono, stickyNotes };
}

test("the user lists the notes, marks one done and restores it", async () => {
  const { hono, stickyNotes } = app();
  const note = stickyNotes.add({ title: "Docs merged", body: "Two docs merge requests went in.", kind: "fyi" });
  const listed = await getJson(hono, "/api/sticky-notes");
  expect(listed.status).toBe(200);
  expect([listed.body.open.map((n: { id: string }) => n.id), listed.body.done.length]).toEqual([[note.id], 0]);
  const done = await postJson(hono, `/api/sticky-notes/${note.id}/done`, {});
  expect([done.status, done.body.note.doneBy]).toEqual([200, "user"]);
  const back = await postJson(hono, `/api/sticky-notes/${note.id}/restore`, {});
  expect([back.status, back.body.note.doneAt]).toEqual([200, null]);
});

test("notes shown to the user are marked seen", async () => {
  const { hono, stickyNotes } = app();
  const note = stickyNotes.add({ title: "Check the keys", body: "New keys are live.", kind: "check" });
  const seen = await postJson(hono, "/api/sticky-notes/seen", { notes: [{ id: note.id, version: note.version }] });
  expect(seen.status).toBe(200);
  expect(stickyNotes.open()[0]!.seen).toBe(true);
  for (const body of [{ ids: [note.id] }, { notes: "all" }, { notes: [{ id: note.id }] }, { notes: [{ id: note.id, version: "1" }] }]) {
    const bad = await postJson(hono, "/api/sticky-notes/seen", body);
    expect([bad.status, typeof bad.body.error]).toEqual([400, "string"]);
  }
});

test("an unknown note is a 404 with words", async () => {
  const { hono } = app();
  const done = await postJson(hono, "/api/sticky-notes/note_missingmissin/done", {});
  expect([done.status, done.body.error]).toEqual([404, "No open note with that id."]);
  const restore = await postJson(hono, "/api/sticky-notes/note_missingmissin/restore", {});
  expect(restore.status).toBe(404);
});
