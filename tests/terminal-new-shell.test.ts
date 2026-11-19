import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { MandateStore } from "../src/server/app/store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { initializeSessionsSchema } from "../src/server/modules/sessions/schema.js";
import { SessionService } from "../src/server/modules/sessions/session-service.js";
import { TerminalPinStore } from "../src/server/modules/sessions/terminal-pins-store.js";
import { mountTerminalRoutes } from "../src/server/modules/sessions/terminal-routes.js";
import { postJson } from "./helpers/test-app.js";
import { tempDir } from "./helpers/temp.js";
import { openShell, shellsSessionName } from "../src/server/modules/sessions/shells-session.js";
import { projectSessionHashForDataDir } from "../src/server/platform/naming/names.js";
import { tmuxKillSession, tmuxNewSession } from "../src/server/platform/tmux/tmux.js";
import { startFakeTmuxServer } from "./helpers/fake-tmux.js";

const DATA = "/home/dev/.mandate";
const HOME = "/home/dev";
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fake() {
  const tmux = startFakeTmuxServer();
  cleanups.push(() => tmux.cleanup());
  return tmux;
}
const ran = (tmux: ReturnType<typeof fake>, sub: string) => tmux.calls.filter((args) => args.includes(sub));

test("the first new terminal makes the shells session in the home folder and returns its first pane", async () => {
  const tmux = fake();
  const shell = await openShell({ tmuxClient: tmux.client, dataDir: DATA, homeDir: HOME });
  const made = ran(tmux, "new-session");
  expect(made).toHaveLength(1);
  expect(made[0]).toEqual(expect.arrayContaining(["-s", shellsSessionName(DATA), "-c", HOME]));
  expect(shell.paneId).toMatch(/^%\d+$/);
  expect(shell.pid).toBeGreaterThan(0);
  expect(ran(tmux, "new-window")).toHaveLength(0);
});

test("later ones add a window to it", async () => {
  const tmux = fake();
  const first = await openShell({ tmuxClient: tmux.client, dataDir: DATA, homeDir: HOME });
  const second = await openShell({ tmuxClient: tmux.client, dataDir: DATA, homeDir: HOME });
  expect(ran(tmux, "new-session")).toHaveLength(1);
  const windows = ran(tmux, "new-window");
  expect(windows).toHaveLength(1);
  expect(windows[0]).toEqual(expect.arrayContaining(["-t", `=${shellsSessionName(DATA)}:`, "-c", HOME]));
  expect(windows[0]).not.toContain("-n");
  expect(second.paneId).not.toBe(first.paneId);
  expect(second.pid).not.toBe(first.pid);
});

test("a session killed by hand is made again", async () => {
  const tmux = fake();
  await openShell({ tmuxClient: tmux.client, dataDir: DATA, homeDir: HOME });
  await tmuxKillSession(shellsSessionName(DATA), tmux.client);
  await openShell({ tmuxClient: tmux.client, dataDir: DATA, homeDir: HOME });
  expect(ran(tmux, "new-session")).toHaveLength(2);
});

test("a session whose name only starts with the shells session's is not taken for it", async () => {
  const tmux = fake();
  await tmuxNewSession(`${shellsSessionName(DATA)}-old`, HOME, tmux.client);
  await openShell({ tmuxClient: tmux.client, dataDir: DATA, homeDir: HOME });
  expect(ran(tmux, "new-session").map((args) => args[args.indexOf("-s") + 1])).toEqual([`${shellsSessionName(DATA)}-old`, shellsSessionName(DATA)]);
  expect(ran(tmux, "new-window")).toHaveLength(0);
});

test("the shells session name can never equal a project's", () => {
  const name = shellsSessionName(DATA);
  expect(name.startsWith("md-")).toBe(false);
  expect(name).toBe(`mandate-shells-${projectSessionHashForDataDir(DATA)}`);
});

test("POST /api/terminals opens a shell, polls tmux before answering, and says why when it cannot", async () => {
  const store = new MandateStore(tempDir("md-new-shell-"));
  initializeSessionsSchema(store.db);
  cleanups.push(() => store.db.close());
  const tmux = fake();
  const order: string[] = [];
  let fail = false;
  const app = new Hono();
  mountTerminalRoutes(app, {
    sessions: new SessionService({ projects: new ProjectsStore(store.db), tmuxClient: tmux.client, getRawState: () => null }),
    tmuxClient: tmux.client,
    pins: new TerminalPinStore(store.db),
    sse: { emit: () => {} },
    getRawState: () => null,
    openShell: async () => {
      if (fail) throw new Error("tmux new-window failed (status 1)");
      order.push("open");
      return { paneId: "%7", pid: 4242 };
    },
    refreshState: async () => { order.push("poll"); }
  });
  expect(await postJson(app, "/api/terminals", {})).toEqual({ status: 200, body: { paneId: "%7", pid: 4242 } });
  expect(order).toEqual(["open", "poll"]);
  fail = true;
  expect(await postJson(app, "/api/terminals", {})).toEqual({ status: 500, body: { error: "tmux new-window failed (status 1)" } });
});
