import { expect, test } from "bun:test";
import { startTestTmuxServer } from "./helpers/tmux-server.js";
import {
  tmuxNewSession,
  tmuxNewWindow,
  tmuxListSessionsWithWindows
} from "../src/server/platform/tmux/tmux.js";

test("tmuxListSessionsWithWindows: empty server returns []", () => {
  const tmux = startTestTmuxServer();
  try {
    expect(tmuxListSessionsWithWindows(tmux.client)).toEqual([]);
  } finally { tmux.cleanup(); }
});

test("tmuxListSessionsWithWindows: returns sessions with their window names", () => {
  const tmux = startTestTmuxServer();
  try {
    tmuxNewSession("alpha", "/tmp", tmux.client);
    tmuxNewSession("beta", "/tmp", tmux.client);
    tmuxNewWindow("alpha", "win1", "/tmp", tmux.client);
    tmuxNewWindow("alpha", "win2", "/tmp", tmux.client);
    const result = tmuxListSessionsWithWindows(tmux.client);
    const byName = new Map(result.map((s) => [s.name, s.windows]));
    expect(byName.has("alpha")).toBeTruthy();
    expect(byName.has("beta")).toBeTruthy();
    // alpha has 3 windows: the default one (named after shell) + win1 + win2.
    // Don't assert exact name of default window — it's whatever the shell is called.
    expect(byName.get("alpha")!.length).toBe(3);
    expect(byName.get("alpha")!.includes("win1")).toBeTruthy();
    expect(byName.get("alpha")!.includes("win2")).toBeTruthy();
    // beta only has its default window
    expect(byName.get("beta")!.length).toBe(1);
  } finally { tmux.cleanup(); }
});
