import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Config } from "../src/server/config.js";
import type { MandateStore } from "../src/server/app/store.js";
import { mountSettingsRoutes } from "../src/server/modules/settings/settings-routes.js";
import { truncateToolResultContent } from "../src/server/platform/db/tool-result-truncate.js";

const RETENTION = { chatRetentionDays: 90, chatMaxTableBytes: 512 * 1024 * 1024, chatToolResultHeadChars: 2000 };

function freshApp(rowCount: number, result: (i: number) => unknown = (i) => `x${i}`.repeat(3000)) {
  const db = new Database(":memory:");
  db.exec(`
    create table agent_messages (
      id text primary key, thread_id text not null, seq integer not null,
      role text not null, source text not null default 'user',
      content text not null, created_at text not null
    );
  `);
  const insert = db.prepare(
    "insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values (?,?,?,?,?,?,?)"
  );
  for (let i = 0; i < rowCount; i += 1) {
    insert.run(
      `m${i}`, "t1", i, "tool", "tool",
      JSON.stringify({ type: "tool_result", toolCallId: `c${i}`, toolName: "bash", result: result(i) }),
      "2020-01-01T00:00:00.000Z"
    );
  }

  const app = new Hono();
  mountSettingsRoutes(app, {
    store: { db } as unknown as MandateStore,
    config: { retention: RETENTION } as unknown as Config
  });
  return { app, db };
}

function backlog(db: Database): number {
  const rows = db.prepare("select content from agent_messages").all() as Array<{ content: string }>;
  return rows.filter((r) => truncateToolResultContent(r.content, 2000) !== null).length;
}

test("cleanup rejects a request that carries no JSON content type", async () => {
  const { app, db } = freshApp(3);

  // A POST with no body and no required header is a CORS *simple request*: any
  // page the user visits while Mandate runs could fire it and irreversibly
  // rewrite chat history. Requiring this content type forces a preflight.
  const res = await app.request("/api/storage/cleanup", { method: "POST" });

  expect(res.status).toBe(415);
  expect(backlog(db)).toBe(3);
});

test("cleanup rejects a form content type, which is also preflight-free", async () => {
  const { app, db } = freshApp(3);

  const res = await app.request("/api/storage/cleanup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }
  });

  expect(res.status).toBe(415);
  expect(backlog(db)).toBe(3);
});

test("cleanup shortens every candidate across chunks, not just the first chunk", async () => {
  // Over the 500-row chunk size on purpose: a single tick can no longer see the
  // whole candidate set, so anything the loop leaves behind shows up here.
  const { app, db } = freshApp(1200);
  expect(backlog(db)).toBe(1200);

  const res = await app.request("/api/storage/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" }
  });

  expect(res.status).toBe(200);
  const body = await res.json() as { ok: boolean; truncated: number };
  expect(body.ok).toBe(true);
  expect(body.truncated).toBe(1200);
  expect(backlog(db)).toBe(0);
});

test("cleanup terminates when the leading rows are ones it cannot shorten", async () => {
  // The chunk loop stops on a tick that changes nothing. That is only sound
  // because the query selects exactly the rows the guard will rewrite -- with a
  // looser predicate these 600 object results would fill the first chunk, the
  // tick would return 0, and the loop would stop having done nothing.
  const { app, db } = freshApp(600, (i) => ({ stdout: `y${i}`.repeat(3000) }));
  const insert = db.prepare(
    "insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values (?,?,?,?,?,?,?)"
  );
  insert.run(
    "real", "t1", 9999, "tool", "tool",
    JSON.stringify({ type: "tool_result", toolCallId: "cr", toolName: "bash", result: "z".repeat(5000) }),
    "2020-01-01T00:00:00.000Z"
  );
  expect(backlog(db)).toBe(1);

  const res = await app.request("/api/storage/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" }
  });

  expect(res.status).toBe(200);
  expect((await res.json() as { truncated: number }).truncated).toBe(1);
  expect(backlog(db)).toBe(0);
});
