import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountPaneRoutes } from "../src/server/modules/panes/pane-routes.js";
import { tmuxNewSession } from "../src/server/platform/tmux/tmux.js";
import type { RawTmuxState } from "../src/server/platform/tmux/tmux-types.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { startFakeTmuxServer } from "./helpers/fake-tmux.js";
import type { CommandResult } from "../src/server/platform/process/command-runner.js";
import { getJson } from "./helpers/test-app.js";

// A pane the last tmux poll does not hold is gone only when tmux says so: a
// listing that failed for a moment leaves the poll empty, and a terminal that
// read that as a 404 would call a live pane closed for good.

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** `fails` answers a tmux command in the fake's place when it returns a result. */
function app(raw: RawTmuxState | null, fails?: (args: string[]) => CommandResult | null) {
  const env = freshStoresEnv("md-pane-lookup-confirmed-");
  const tmux = startFakeTmuxServer();
  cleanups.push(() => tmux.cleanup());
  const inner = tmux.client.runner!;
  const tmuxClient = fails ? { ...tmux.client, runner: { run: async (cmd: string, args: string[], options?: never) => fails(args) ?? inner.run(cmd, args, options) } } : tmux.client;
  const routes = new Hono();
  mountPaneRoutes(routes, { projects: env.projects, workers: env.workers, tmuxClient, getRawState: () => raw, refreshWindows: () => {} });
  return { routes, tmux };
}

test("a pane the poll missed but tmux still has is not found yet, not gone", async () => {
  const { routes, tmux } = app({ sessions: [], windows: [], panes: [] });
  await tmuxNewSession("work", "/tmp", tmux.client);
  const paneId = tmux.answer(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.trim();
  const r = await getJson(routes, `/api/panes/${encodeURIComponent(paneId)}`);
  expect(r.status).toBe(503);
});

test("a pane tmux does not have is gone", async () => {
  const { routes } = app({ sessions: [], windows: [], panes: [] });
  expect((await getJson(routes, "/api/panes/%25999")).status).toBe(404);
});

test("a tmux that fails for a moment says nothing about the pane: not found yet, not gone", async () => {
  for (const stderr of ["lost server", "error connecting to /tmp/tmux-501/default (Resource temporarily unavailable)"]) {
    const { routes, tmux } = app({ sessions: [], windows: [], panes: [] }, (args) => args.includes("display-message") ? { status: 1, signal: null, stdout: "", stderr } : null);
    await tmuxNewSession("work", "/tmp", tmux.client);
    expect((await getJson(routes, "/api/panes/%25999")).status).toBe(503);
  }
});

test("no tmux server at all: the pane is gone", async () => {
  const { routes } = app({ sessions: [], windows: [], panes: [] }, (args) => args.includes("display-message") ? { status: 1, signal: null, stdout: "", stderr: "no server running on /tmp/tmux-501/default" } : null);
  expect((await getJson(routes, "/api/panes/%25999")).status).toBe(404);
});
