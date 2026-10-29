import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WindowWatchManager } from "../src/server/modules/agent/window-watch-manager.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import type { AgentMessage, AgentStore, AgentThread } from "../src/server/modules/agent/agent-store.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { stub } from "./helpers/typed.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  return db;
}

/** timeout_at and timeout_ms are selected because the update path writes them
 *  too: without them here, dropping either from that UPDATE leaves this whole
 *  file green while an agent that extended a watch from 30 minutes to 2 hours
 *  gets its timeout wake at the 30-minute mark after a restart. */
interface WatchRow {
  id: string; pane_id: string; stable_ms: number; timeout_at: string; timeout_ms: number | null;
}
function rows(db: Database): WatchRow[] {
  return db.prepare<WatchRow, []>(
    "select id, pane_id, stable_ms, timeout_at, timeout_ms from agent_window_watches"
  ).all();
}

/** Minimal deps: this file is about the table, not about waking anyone.
 *
 *  getPaneState reports "ok" with a null changedAt rather than
 *  "snapshot_unavailable": register() calls assertTargetAvailable()
 *  unconditionally (window-watch-manager.ts:95) and rejects
 *  "snapshot_unavailable" targets with a thrown error, so a fixture that
 *  reported it would make every register() call in this file throw before
 *  ever reaching the table. A null changedAt still keeps checkAll() from
 *  firing anything (`if (!changedAtStr) continue;`), so it is exactly as
 *  inert for "not about waking anyone" purposes. */
function makeManager(db: Database) {
  return new WindowWatchManager({
    db,
    agentStore: stub<AgentStore>({ getThreadById: () => stub<AgentThread>({ id: "thr_a", archivedAt: null }) }),
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: () => null,
    isThreadBusy: () => false,
    getPaneState: () => ({ status: "ok", changedAt: null }),
    capturePaneTail: async () => null
  });
}

test("cancelThread removes its rows too", () => {
  // Without this the watch comes back on the next boot, after the thread that
  // owned it is gone.
  const db = freshDb();
  const manager = makeManager(db);
  try {
    manager.register({ ownerThreadId: "thr_a", windowKey: "s:w", paneId: "%1", stableMs: 1000 });
    manager.cancelThread("thr_a");
    expect(rows(db)).toEqual([]);
  } finally {
    manager.dispose();
  }
});

test("an update rewrites the row rather than adding one, including the new deadline", () => {
  const db = freshDb();
  const manager = makeManager(db);
  try {
    manager.register({
      ownerThreadId: "thr_a", windowKey: "s:w", paneId: "%1", stableMs: 1000, timeoutMs: 60_000
    });
    const before = rows(db);
    expect(before).toHaveLength(1);
    expect(before[0]!.timeout_ms).toBe(60_000);

    manager.register({
      ownerThreadId: "thr_a", windowKey: "s:w", paneId: "%1", stableMs: 7000, timeoutMs: 7_200_000
    });
    const after = rows(db);
    expect(after).toHaveLength(1);
    expect(after[0]!.stable_ms).toBe(7000);
    // Both timeout columns, not just stable_ms: a restart reads timeout_at to
    // re-arm the timer and timeout_ms to decide whether the next registration
    // is the same request. The rows are written from the same clock the manager
    // used, so the gap is the two requested durations minus the (sub-second)
    // time between the calls.
    expect(after[0]!.timeout_ms).toBe(7_200_000);
    expect(Date.parse(after[0]!.timeout_at) - Date.parse(before[0]!.timeout_at))
      .toBeGreaterThan(7_000_000);
  } finally {
    manager.dispose();
  }
});

test("dispose does NOT delete rows, and a new manager picks them back up", () => {
  // This is the guard against implementing the fix backwards. dispose() is
  // process shutdown, not the end of a watch's life; deleting there would wipe
  // the table on every restart, which is the bug the table exists to fix and
  // would look identical to a clean shutdown.
  const db = freshDb();
  const first = makeManager(db);
  first.register({ ownerThreadId: "thr_a", windowKey: "s:w", paneId: "%1", stableMs: 1000 });
  first.dispose();
  expect(rows(db)).toHaveLength(1);

  const second = makeManager(db);
  try {
    // Every restored field read together with the name it sits under. A
    // rehydration that put window_key into paneId, or dropped stableMs, would
    // still produce one watch with a paneId — asserting the count alone, or the
    // paneId alone, would pass through both bugs.
    expect(second.list("thr_a").map((w) => ({
      paneId: w.paneId, windowKey: w.windowKey, stableMs: w.stableMs
    }))).toEqual([{ paneId: "%1", windowKey: "s:w", stableMs: 1000 }]);
    expect(second.activeWatchCount()).toBe(1);
  } finally {
    second.dispose();
  }
});

test("a restored watch whose window elapsed before the restart still waits a full stableMs from boot", async () => {
  // The load-bearing premise of restoring watches at all: rehydration cannot
  // mis-fire a watch that was already settled when the process went down.
  // `paneActivity` in tmux-state.ts is a module-level map that starts empty, so
  // the first poll after boot stamps every pane's changedAt with the boot time,
  // and the stability check is `now - max(changedAt, createdAtMs) >= stableMs`.
  //
  // Reaching that comparison is the point of this fixture. The other tests in
  // this file report `changedAt: null` or `snapshot_unavailable`, both of which
  // return out of checkAll() before the comparison ever runs, so they say
  // nothing about this behaviour either way.
  const db = freshDb();
  const bootMs = Date.now();
  let nowMs = bootMs;
  const woken: string[] = [];
  // Registered a minute before the restart with a 5s window: on paper it
  // settled long ago. timeout_at is far enough out that the timeout path
  // cannot be what fires, so a wake here can only come from the stability check.
  db.prepare(
    `insert into agent_window_watches
       (id, thread_id, window_key, pane_id, stable_ms, note, created_at, timeout_at, timeout_ms)
     values ('ww_restored', 'thr_a', 's:w', '%1', 5000, '', ?, ?, 600000)`
  ).run(new Date(bootMs - 60_000).toISOString(), new Date(bootMs + 600_000).toISOString());

  const manager = new WindowWatchManager({
    db,
    agentStore: stub<AgentStore>({
      getThreadById: () => stub<AgentThread>({ id: "thr_a", archivedAt: null }),
      appendMessage: () => stub<AgentMessage>({ id: "msg_1" })
    }),
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (threadId) => { woken.push(threadId); return "wake-1"; },
    isThreadBusy: () => false,
    // Boot time, which is what a real first poll produces: we do not know
    // whether the pane was quiet while we were down, so it counts as active now.
    getPaneState: () => ({ status: "ok", changedAt: new Date(bootMs).toISOString() }),
    capturePaneTail: async () => "restored pane output",
    now: () => nowMs
  });

  try {
    await (manager as any).checkAll();
    // Negative half: no immediate fire on the first tick after boot.
    expect(woken).toStrictEqual([]);
    expect(rows(db)).toHaveLength(1);

    // Positive half: it is genuinely still armed and fires once the window has
    // elapsed from boot. Without this, "never fires at all" would pass above.
    nowMs = bootMs + 5000;
    await (manager as any).checkAll();
    expect(woken).toStrictEqual(["thr_a"]);
    expect(rows(db)).toEqual([]);
  } finally {
    manager.dispose();
  }
});

test("a row whose timeout already passed fires instead of being dropped", () => {
  const db = freshDb();
  const woken: string[] = [];
  db.prepare(
    `insert into agent_window_watches
       (id, thread_id, window_key, pane_id, stable_ms, note, created_at, timeout_at)
     values ('ww_old', 'thr_a', 's:w', '%1', 1000, '', ?, ?)`
  ).run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 30_000).toISOString());

  const manager = new WindowWatchManager({
    db,
    // getThreadById alone is not enough here: an immediate fire goes through
    // deliverTrigger's full path (no pending.messageId yet), which calls
    // agentStore.appendMessage() before onWake() — omitting it throws
    // "appendMessage is not a function" and onWake never runs, so `woken`
    // would stay empty for a reason that has nothing to do with rehydration.
    agentStore: stub<AgentStore>({
      getThreadById: () => stub<AgentThread>({ id: "thr_a", archivedAt: null }),
      appendMessage: () => stub<AgentMessage>({ id: "msg_1" })
    }),
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    // A wake that starts: one that does not (null) leaves the row until it is
    // delivered, so it survives a restart.
    onWake: (threadId) => { woken.push(threadId); return "wake_1"; },
    isThreadBusy: () => false,
    getPaneState: () => ({ status: "snapshot_unavailable" }),
    capturePaneTail: async () => null
  });
  // Give the rehydration's immediate timeout a tick to run. dispose() has to
  // happen inside the callback, not in an outer `finally`: with `return
  // new Promise(...)` in a try block, `finally` runs synchronously right
  // after the return statement is evaluated — before the promise settles —
  // so `manager.dispose()` there would clear the rehydrated watch's timer
  // before it ever fires, and `woken` would stay empty for a reason that has
  // nothing to do with rehydration.
  return new Promise<void>((resolve) => setTimeout(() => {
    try {
      expect(woken).toContain("thr_a");
      expect(rows(db)).toEqual([]);
    } finally {
      manager.dispose();
      resolve();
    }
  }, 50));
});
