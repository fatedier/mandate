import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { deleteJson, getJson, patchJson, postJson } from "./helpers/test-app.js";
import { taskBoardModule } from "../src/server/modules/task-board/module.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import type { AppDeps } from "../src/server/app/deps.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function app(prefix: string, opened?: (id: string) => void) {
  env = freshStoresEnv(prefix);
  const taskBoard = new TaskBoardService({
    db: env.store.db, agentStore: env.agentStore,
    sse: { emit: () => {} } as never, threadDots: () => new Map(),
    ...(opened ? { onOpened: opened } : {})
  });
  const hono = new Hono();
  taskBoardModule.mountRoutes!(hono, { deps: { taskBoard } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  return { hono, taskBoard };
}

test("the owner creates, edits, closes and comments", async () => {
  const { hono } = app("md-tb-routes-");
  const created = await postJson(hono, "/api/task-board/tasks", { title: "Scale recipes per serving", description: "Long brief", dueDate: "2026-11-20" });
  expect(created.status).toBe(201);
  expect(created.body.task).toMatchObject({ title: "Scale recipes per serving", description: "Long brief", dueDate: "2026-11-20", status: "todo", createdBy: "owner" });
  const id = created.body.task.id as string;
  const done = await patchJson(hono, `/api/task-board/tasks/${id}`, { status: "done" });
  expect(done.status).toBe(200);
  expect(done.body.task.status).toBe("done");
  const renamed = await patchJson(hono, `/api/task-board/tasks/${id}`, { title: "Scale party recipes per serving", dueDate: null });
  expect(renamed.body.task).toMatchObject({ title: "Scale party recipes per serving", dueDate: null });
  const comment = await postJson(hono, `/api/task-board/tasks/${id}/comments`, { text: "3.21 waits for this." });
  expect(comment.status).toBe(201);
  expect(comment.body.entry).toMatchObject({ kind: "comment", by: "owner", text: "3.21 waits for this." });
  const read = await getJson(hono, `/api/task-board/tasks/${id}`);
  expect(read.body.task.entries.map((e: { kind: string }) => e.kind)).toEqual(["status", "comment"]);
});

test("refusals answer 400 or 404 with their reason", async () => {
  const { hono } = app("md-tb-routes-refuse-");
  expect((await postJson(hono, "/api/task-board/tasks", { title: "  " })).status).toBe(400);
  const id = (await postJson(hono, "/api/task-board/tasks", { title: "x" })).body.task.id as string;
  const bogus = await patchJson(hono, `/api/task-board/tasks/${id}`, { status: "bogus" });
  expect(bogus).toEqual({ status: 400, body: { error: "unknown status" } });
  expect((await postJson(hono, `/api/task-board/tasks/${id}/comments`, { text: "" })).status).toBe(400);
  expect((await patchJson(hono, `/api/task-board/tasks/${id}`, { dueDate: "20 Nov" })).status).toBe(400);
  expect((await getJson(hono, "/api/task-board/tasks/tsk_nothinghere")).status).toBe(404);
});

test("delete, list the deleted, restore; delete all Done", async () => {
  const { hono } = app("md-tb-routes-delete-");
  const a = (await postJson(hono, "/api/task-board/tasks", { title: "a" })).body.task.id as string;
  const b = (await postJson(hono, "/api/task-board/tasks", { title: "b" })).body.task.id as string;
  expect((await deleteJson(hono, `/api/task-board/tasks/${a}`)).status).toBe(200);
  expect((await getJson(hono, "/api/task-board/tasks")).body.tasks.map((t: { id: string }) => t.id)).toEqual([b]);
  expect((await getJson(hono, "/api/task-board/tasks?deleted=1")).body.tasks.map((t: { id: string }) => t.id)).toEqual([a]);
  expect((await postJson(hono, `/api/task-board/tasks/${a}/restore`, {})).status).toBe(200);
  await patchJson(hono, `/api/task-board/tasks/${b}`, { status: "done" });
  expect(await deleteJson(hono, "/api/task-board/done")).toEqual({ status: 200, body: { deleted: 1 } });
  expect((await getJson(hono, "/api/task-board/tasks")).body.tasks.map((t: { id: string }) => t.id)).toEqual([a]);
});

test("a deleted task is deleted forever; one on the board is not", async () => {
  const { hono } = app("md-tb-routes-forever-");
  const a = (await postJson(hono, "/api/task-board/tasks", { title: "a" })).body.task.id as string;
  expect(await deleteJson(hono, `/api/task-board/tasks/${a}/forever`)).toEqual({ status: 409, body: { error: `no such task in Recently deleted: ${a}` } });
  expect((await getJson(hono, "/api/task-board/tasks")).body.tasks.map((t: { id: string }) => t.id)).toEqual([a]);
  await deleteJson(hono, `/api/task-board/tasks/${a}`);
  expect(await deleteJson(hono, `/api/task-board/tasks/${a}/forever`)).toEqual({ status: 200, body: { ok: true } });
  expect((await getJson(hono, "/api/task-board/tasks?deleted=1")).body.tasks).toEqual([]);
  expect((await deleteJson(hono, `/api/task-board/tasks/${a}/forever`)).status).toBe(404);
});

// A read is not the owner looking (a detail re-reads in the background):
// only the page's "opened" says so.
test("the owner opening a task tells the board it was opened; reading it does not", async () => {
  const opened: string[] = [];
  const { hono } = app("md-tb-routes-opened-", (id) => opened.push(id));
  const id = (await postJson(hono, "/api/task-board/tasks", { title: "x" })).body.task.id as string;
  expect((await getJson(hono, `/api/task-board/tasks/${id}`)).status).toBe(200);
  expect(opened).toEqual([]);
  expect((await postJson(hono, `/api/task-board/tasks/${id}/opened`, {})).status).toBe(200);
  expect(opened).toEqual([id]);
  // Unknown: refused, nothing told.
  expect((await postJson(hono, "/api/task-board/tasks/tsk_nothinghere/opened", {})).status).toBe(404);
  expect(opened).toEqual([id]);
});
