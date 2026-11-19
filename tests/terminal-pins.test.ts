import { afterEach, expect, test } from "bun:test";
import os from "node:os";
import { Hono } from "hono";
import { MandateStore } from "../src/server/app/store.js";
import { onHttpError } from "../src/server/app/http-app.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { SessionService } from "../src/server/modules/sessions/session-service.js";
import { initializeSessionsSchema } from "../src/server/modules/sessions/schema.js";
import { TerminalPinStore } from "../src/server/modules/sessions/terminal-pins-store.js";
import { mountTerminalRoutes } from "../src/server/modules/sessions/terminal-routes.js";
import { tmuxNewSession } from "../src/server/platform/tmux/tmux.js";
import type { RawTmuxPane, RawTmuxState } from "../src/server/platform/tmux/tmux-types.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";
import type { CommandResult, CommandRunOptions } from "../src/server/platform/process/command-runner.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import { startFakeTmuxServer, type FakeTmuxServer } from "./helpers/fake-tmux.js";
import { deleteJson, getJson, postJson, putJson } from "./helpers/test-app.js";
import { tempDir } from "./helpers/temp.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function freshStore(): MandateStore {
  const store = new MandateStore(tempDir("md-terminal-pins-"));
  initializeSessionsSchema(store.db);
  cleanups.push(() => store.db.close());
  return store;
}

function pane(paneId: string, pid: number, over: Partial<RawTmuxPane> = {}): RawTmuxPane {
  return {
    sessionName: "work", windowId: "@1", paneId, windowIndex: 0, windowName: "main", paneIndex: 0,
    paneActive: true, windowActive: true, currentPath: "/home/dev/work", currentCommand: "zsh",
    paneTitle: "", panePid: pid, paneTty: "/dev/ttys001", paneWidth: 120, paneHeight: 40,
    captureHash: "h", changedAt: "2026-11-13T00:00:00.000Z", preview: "", processes: [], foregroundProcesses: [],
    ...over
  };
}

function raw(panes: RawTmuxPane[]): RawTmuxState {
  return {
    sessions: [],
    windows: [{ sessionName: "work", windowId: "@1", windowIndex: 0, windowName: "main", windowActive: true, windowPanes: panes.length, windowLayout: "", windowZoomed: false }],
    panes
  };
}

/** A tmux whose `list-panes -a` answers as `listPanes` says, else as the fake. */
function tmuxWith(tmux: FakeTmuxServer, listPanes?: () => CommandResult): TmuxClient {
  if (!listPanes) return tmux.client;
  return {
    socketArgs: [],
    runner: {
      run: async (binary: string, args: string[], opts?: CommandRunOptions) =>
        args.includes("list-panes") && args.includes("-a") ? listPanes() : tmux.client.runner!.run(binary, args, opts)
    }
  };
}

async function appWith(state: () => RawTmuxState | null, listPanes?: () => CommandResult) {
  const store = freshStore();
  const tmux: FakeTmuxServer = startFakeTmuxServer();
  cleanups.push(() => tmux.cleanup());
  const client = tmuxWith(tmux, listPanes);
  const events: string[] = [];
  const pins = new TerminalPinStore(store.db);
  const app = new Hono();
  app.onError(onHttpError);
  mountTerminalRoutes(app, {
    sessions: new SessionService({ projects: new ProjectsStore(store.db), tmuxClient: client, getRawState: state }),
    tmuxClient: client,
    pins,
    sse: { emit: (event: string) => { events.push(event); } },
    getRawState: state,
    openShell: async () => ({ paneId: "%70", pid: 7070 }),
    refreshState: async () => {}
  });
  return { app, pins, events, tmux };
}

test("pins keep their order and a pane is pinned once", () => {
  const pins = new TerminalPinStore(freshStore().db);
  expect(pins.add("%1", 101)).toBe(true);
  expect(pins.add("%2", 102)).toBe(true);
  expect(pins.add("%1", 101)).toBe(false);
  expect(pins.list().map((p) => p.paneId)).toEqual(["%1", "%2"]);
  expect(pins.list()[0]).toMatchObject({ paneId: "%1", pid: 101 });
});

test("a pin whose pane is gone, or whose pane id now has another pid, is dropped", () => {
  const pins = new TerminalPinStore(freshStore().db);
  pins.add("%1", 101);
  pins.add("%2", 102);
  pins.add("%3", 103);
  expect(pins.dropMissing([{ paneId: "%1", pid: 101 }, { paneId: "%2", pid: 999 }])).toBe(2);
  expect(pins.list().map((p) => p.paneId)).toEqual(["%1"]);
});

test("GET /api/terminals lists sessions with title and pid and drops stale pins", async () => {
  const state = raw([
    pane("%1", 101, { currentCommand: "codex", paneTitle: "Catalogue import" }),
    pane("%2", 102, { paneIndex: 1, paneTitle: os.hostname() }),
    pane("%3", 103, { paneIndex: 2, paneTitle: os.hostname().split(".")[0] })
  ]);
  const { app, pins, tmux, events } = await appWith(() => state);
  await tmuxNewSession("work", "/home/dev/work", tmux.client);
  const [livePane, livePid] = tmux.answer(["list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"]).stdout.trim().split(" ");
  pins.add(livePane!, Number(livePid));
  pins.add("%9", 909);

  const r = await getJson(app, "/api/terminals");
  expect(r.status).toBe(200);
  const panes = r.body.sessions[0].windows[0].panes;
  expect(panes.map((p: any) => [p.paneId, p.title, p.pid])).toEqual([["%1", "Catalogue import", 101], ["%2", null, 102], ["%3", null, 103]]);
  expect(r.body.pins.map((p: any) => p.paneId)).toEqual([livePane]);
  // The cleanup told the other devices, once; a read that drops nothing is silent.
  expect(events).toEqual([SSE_EVENTS.terminalPinsChanged]);
  await getJson(app, "/api/terminals");
  expect(events).toHaveLength(1);
});

test("a pane listing that fails keeps every pin", async () => {
  const { app, pins, events } = await appWith(() => raw([]), () => ({ status: 1, signal: null, stdout: "", stderr: "lost server" }));
  pins.add("%1", 101);
  const r = await getJson(app, "/api/terminals");
  expect(r.status).toBe(200);
  expect(r.body.pins.map((p: any) => p.paneId)).toEqual(["%1"]);
  expect(events).toEqual([]);
});

test("tmux refusing the connection is not tmux having no panes: every pin stays", async () => {
  const { app, pins } = await appWith(() => raw([]), () => ({ status: 1, signal: null, stdout: "", stderr: "error connecting to /tmp/tmux-501/default (Permission denied)" }));
  pins.add("%1", 101);
  expect((await getJson(app, "/api/terminals")).body.pins.map((p: any) => p.paneId)).toEqual(["%1"]);
});

test("a pin made while a list read waits on tmux is not judged by that older listing", async () => {
  let answer!: (r: CommandResult) => void;
  const listing = new Promise<CommandResult>((resolve) => { answer = resolve; });
  const state = raw([pane("%1", 101), pane("%2", 102, { paneIndex: 1 })]);
  const { app, pins } = await appWith(() => state, () => listing as unknown as CommandResult);
  pins.add("%1", 101);
  const read = getJson(app, "/api/terminals");
  await new Promise((r) => setTimeout(r, 5));
  expect((await postJson(app, "/api/terminals/pins", { paneId: "%2", pid: 102 })).status).toBe(200);
  // tmux listed before %2 existed.
  answer({ status: 0, signal: null, stdout: "%1 101\n", stderr: "" });
  expect((await read).body.pins.map((p: any) => p.paneId)).toEqual(["%1", "%2"]);
  expect(pins.list().map((p) => p.paneId)).toEqual(["%1", "%2"]);
});

test("no tmux server: a missing socket is no server too", async () => {
  const { app, pins } = await appWith(() => raw([]), () => ({ status: 1, signal: null, stdout: "", stderr: "error connecting to /tmp/tmux-501/default (No such file or directory)" }));
  pins.add("%1", 101);
  expect((await getJson(app, "/api/terminals")).body.pins).toEqual([]);
});

test("no tmux server at all drops every pin", async () => {
  const { app, pins } = await appWith(() => raw([]), () => ({ status: 1, signal: null, stdout: "", stderr: "no server running on /tmp/tmux-501/default" }));
  pins.add("%1", 101);
  expect((await getJson(app, "/api/terminals")).body.pins).toEqual([]);
});

test("no tmux server reads as no sessions, not an error", async () => {
  const { app } = await appWith(() => raw([]));
  const r = await getJson(app, "/api/terminals");
  expect(r).toEqual({ status: 200, body: { sessions: [], pins: [] } });
});

test("pin and unpin broadcast terminalPinsChanged; pinning a pane that is not live is a 404", async () => {
  const state = raw([pane("%1", 101)]);
  const { app, events } = await appWith(() => state);

  const pinned = await postJson(app, "/api/terminals/pins", { paneId: "%1", pid: 101 });
  expect(pinned.status).toBe(200);
  expect(pinned.body.pins.map((p: any) => p.paneId)).toEqual(["%1"]);
  expect(events).toEqual([SSE_EVENTS.terminalPinsChanged]);

  expect(await postJson(app, "/api/terminals/pins", { paneId: "%9", pid: 1 })).toEqual({ status: 404, body: { error: "pane not found" } });
  expect(await postJson(app, "/api/terminals/pins", { paneId: "%1", pid: 5 })).toEqual({ status: 404, body: { error: "pane not found" } });
  expect((await postJson(app, "/api/terminals/pins", { paneId: 1 })).status).toBe(400);
  expect(events).toHaveLength(1);

  const unpinned = await deleteJson(app, "/api/terminals/pins/%251");
  expect(unpinned).toEqual({ status: 200, body: { pins: [] } });
  expect(events).toHaveLength(2);
  expect(await deleteJson(app, "/api/terminals/pins/%251")).toEqual({ status: 404, body: { error: "pin not found" } });
});

test("pinning a pane whose id still holds a pin of the pane before it (another pid) pins the new one, at the end", async () => {
  const state = raw([pane("%1", 202), pane("%2", 102, { paneIndex: 1 })]);
  const { app, pins, events } = await appWith(() => state);
  pins.add("%1", 101);
  pins.add("%2", 102);
  const r = await postJson(app, "/api/terminals/pins", { paneId: "%1", pid: 202 });
  expect(r.status).toBe(200);
  expect(r.body.pins.map((p: any) => [p.paneId, p.pid])).toEqual([["%2", 102], ["%1", 202]]);
  expect(events).toEqual([SSE_EVENTS.terminalPinsChanged]);
});


// Dragged into another order on the Terminals page: the order is the
// server's, shared by every device.
const ids = (pins: TerminalPinStore) => pins.list().map((p) => p.paneId);

test("a new pin goes last, after pins put in another order", () => {
  const pins = new TerminalPinStore(freshStore().db);
  pins.add("%1", 101);
  pins.add("%2", 102);
  pins.add("%3", 103);
  expect(pins.reorder([{ paneId: "%3", pid: 103 }, { paneId: "%1", pid: 101 }])).toBe(true);
  expect(ids(pins)).toEqual(["%3", "%1", "%2"]);
  pins.add("%4", 104);
  expect(ids(pins)).toEqual(["%3", "%1", "%2", "%4"]);
});

test("the order puts the listed pins first in that order; unlisted pins keep theirs after, unknown ones are skipped", () => {
  const pins = new TerminalPinStore(freshStore().db);
  pins.add("%1", 101);
  pins.add("%2", 102);
  pins.add("%3", 103);
  pins.reorder([{ paneId: "%2", pid: 102 }, { paneId: "%9", pid: 9 }, { paneId: "%1", pid: 555 }]);
  expect(ids(pins)).toEqual(["%2", "%1", "%3"]);
  // The same order again changes nothing.
  expect(pins.reorder([{ paneId: "%2", pid: 102 }])).toBe(false);
});

test("pins with no position (made before the column) keep the order they were made in, after placed ones", () => {
  const store = freshStore();
  const at = (minute: number) => `2026-11-13T00:0${minute}:00.000Z`;
  store.db.prepare("insert into terminal_pins (pane_id, pane_pid, pinned_at, position) values (?, ?, ?, null)").run("%2", 102, at(2));
  store.db.prepare("insert into terminal_pins (pane_id, pane_pid, pinned_at, position) values (?, ?, ?, null)").run("%1", 101, at(1));
  store.db.prepare("insert into terminal_pins (pane_id, pane_pid, pinned_at, position) values (?, ?, ?, 1)").run("%3", 103, at(3));
  expect(ids(new TerminalPinStore(store.db))).toEqual(["%3", "%1", "%2"]);
});

test("PUT /api/terminals/pins/order sets the order, answers the list and broadcasts once it changed", async () => {
  const { app, pins, events } = await appWith(() => raw([pane("%1", 101), pane("%2", 102, { paneIndex: 1 })]));
  pins.add("%1", 101);
  pins.add("%2", 102);
  const order = { pins: [{ paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }] };
  const moved = await putJson(app, "/api/terminals/pins/order", order);
  expect(moved.status).toBe(200);
  expect(moved.body.pins.map((p: any) => [p.paneId, p.pid])).toEqual([["%2", 102], ["%1", 101]]);
  expect(events).toEqual([SSE_EVENTS.terminalPinsChanged]);
  expect((await putJson(app, "/api/terminals/pins/order", order)).status).toBe(200);
  expect(events).toHaveLength(1);
  expect(await putJson(app, "/api/terminals/pins/order", { pins: "x" })).toEqual({ status: 400, body: { error: "pins must be a list of { paneId, pid }" } });
  expect(await putJson(app, "/api/terminals/pins/order", { pins: [{ paneId: "%1" }] })).toEqual({ status: 400, body: { error: "pins must be a list of { paneId, pid }" } });
  expect(await putJson(app, "/api/terminals/pins/order", "{")).toEqual({ status: 400, body: { error: "invalid JSON" } });
  expect(events).toHaveLength(1);
});

test("a pin whose pane is gone is still dropped after the pins were put in another order, the rest keeping theirs", () => {
  const pins = new TerminalPinStore(freshStore().db);
  pins.add("%1", 101);
  pins.add("%2", 102);
  pins.add("%3", 103);
  pins.reorder([{ paneId: "%3", pid: 103 }, { paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }]);
  expect(pins.dropMissing([{ paneId: "%3", pid: 103 }, { paneId: "%1", pid: 101 }])).toBe(1);
  expect(ids(pins)).toEqual(["%3", "%1"]);
});

// Pins with no position (an older binary wrote them) are the first ones
// made; a new pin goes after them.
test("a pin made after pins with no position goes last, and so does a pane re-pinned with a new pid", () => {
  const store = freshStore();
  const legacy = store.db.prepare("insert into terminal_pins (pane_id, pane_pid, pinned_at) values (?, ?, ?)");
  legacy.run("%1", 101, "2026-11-13T00:01:00.000Z");
  legacy.run("%2", 102, "2026-11-13T00:02:00.000Z");
  const pins = new TerminalPinStore(store.db);
  pins.add("%3", 103);
  expect(ids(pins)).toEqual(["%1", "%2", "%3"]);
  pins.add("%1", 201);
  expect(pins.list().map((p) => `${p.paneId}:${p.pid}`)).toEqual(["%2:102", "%3:103", "%1:201"]);
});
