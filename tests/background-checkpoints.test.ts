import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { startBackgroundCheckpoints, type CheckpointWorker } from "../src/server/platform/db/checkpoint-away.js";
import { tempDir } from "./helpers/temp.js";
import { waitUntil } from "./helpers/wait.js";

// SQLite checkpoints a WAL database itself when the log reaches 1000 pages,
// on the thread whose COMMIT crossed it: here the server's only thread,
// which then waits for the copy and its sync. The server's connection hands
// that to a worker of its own, and takes it back if the worker cannot do it.

function walDatabase() {
  const dir = tempDir("md-checkpoints-");
  const file = path.join(dir, "mandate.db");
  const db = new Database(file);
  db.exec("pragma journal_mode = wal");
  db.exec("create table notes (id integer primary key, body text not null)");
  return { dir, file, db, autoPages: () => (db.prepare("pragma wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint };
}

test("a worker checkpoints: the server's connection stops doing it once the worker has, and what it writes reaches the database file", async () => {
  const w = walDatabase();
  const checkpoints = startBackgroundCheckpoints(w.db, { intervalMs: 50 });
  try {
    await waitUntil(() => w.autoPages() === 0, { label: "the server's connection hands checkpoints over" });
    const before = fs.statSync(w.file).size;
    const insert = w.db.prepare("insert into notes (body) values (?)");
    // Well past SQLite's own 1000 pages: the server's connection would have
    // checkpointed inline.
    for (let i = 0; i < 3000; i++) insert.run("x".repeat(2000));
    await waitUntil(() => fs.statSync(w.file).size > before + 4_000_000, { label: "the worker copies the log into the database file" });
  } finally {
    checkpoints.stop();
    w.db.close();
  }
});

test("stopping gives checkpoints back to the server's connection", async () => {
  const w = walDatabase();
  const checkpoints = startBackgroundCheckpoints(w.db, { intervalMs: 50 });
  try {
    await waitUntil(() => w.autoPages() === 0, { label: "handed over" });
    checkpoints.stop();
    expect(w.autoPages()).toBe(1000);
  } finally {
    w.db.close();
  }
});

/** A worker the test drives: what it says, and whether it was ended. */
function fakeWorker() {
  const worker = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    posted: [] as unknown[],
    terminated: false,
    postMessage(message: unknown) { worker.posted.push(message); },
    terminate() { worker.terminated = true; },
    say(message: unknown) { worker.onmessage?.({ data: message } as MessageEvent<unknown>); }
  };
  return worker;
}

test("a worker that fails before its first checkpoint leaves SQLite's own checkpoints on", () => {
  const w = walDatabase();
  const worker = fakeWorker();
  const checkpoints = startBackgroundCheckpoints(w.db, { intervalMs: 50, spawn: () => worker as unknown as CheckpointWorker });
  try {
    worker.say({ ok: false, message: "unable to open database file" });
    expect(w.autoPages()).toBe(1000);
    expect(worker.terminated).toBe(true);
  } finally {
    checkpoints.stop();
    w.db.close();
  }
});

test("a worker that fails, or falls silent, after taking checkpoints over gives them back", async () => {
  const w = walDatabase();
  const failing = fakeWorker();
  const first = startBackgroundCheckpoints(w.db, { intervalMs: 50, spawn: () => failing as unknown as CheckpointWorker });
  try {
    failing.say({ ok: true, busy: 0, log: 0, checkpointed: 0 });
    expect(w.autoPages()).toBe(0);
    failing.say({ ok: false, message: "disk I/O error" });
    expect(w.autoPages()).toBe(1000);
    expect(failing.terminated).toBe(true);
  } finally {
    first.stop();
  }
  const silent = fakeWorker();
  const second = startBackgroundCheckpoints(w.db, { intervalMs: 50, spawn: () => silent as unknown as CheckpointWorker });
  try {
    silent.say({ ok: true, busy: 0, log: 0, checkpointed: 0 });
    expect(w.autoPages()).toBe(0);
    // Nothing more from it for several intervals.
    await waitUntil(() => w.autoPages() === 1000, { label: "checkpoints back after the worker fell silent" });
    expect(silent.terminated).toBe(true);
  } finally {
    second.stop();
    w.db.close();
  }
});
