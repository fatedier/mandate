import { expect, spyOn, test } from "bun:test";
import { capturePanePreview, captureStaggerDelayMs, getRawTmuxState } from "../src/server/platform/tmux/tmux-state.js";
import { createPaneCaptureCache, PANE_REFRESH_MS } from "../src/server/platform/tmux/pane-capture-cache.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";

// The poll captures a pane again only when tmux says its window had output
// since the last capture, or something about the pane itself changed; else
// it keeps what it captured. tmux sets a window's activity time (to the
// second) on every chunk of pane output. A minute at most passes between two
// captures of any pane, and a change found then that tmux did not report as
// activity makes the poll stop trusting it: every pane, every poll, again.

interface FakePane { id: string; windowId: string; width: number; height: number; command: string; path: string; pid: number; history: number; text: string; processes?: string[] }

function fakeTmux() {
  const activity = new Map<string, number>();
  const panes: FakePane[] = [];
  const captures = new Map<string, number>();
  let beforeCapture: ((paneId: string) => void) | null = null;
  const render = (format: string, vars: Record<string, string | number>) =>
    format.replace(/#\{([a-z_]+)\}/g, (_, name: string) => String(vars[name] ?? ""));
  const windowVars = (windowId: string) => ({
    session_name: "s", window_id: windowId, window_index: windowId.slice(1), window_name: `w${windowId.slice(1)}`, window_active: "1",
    window_panes: panes.filter((p) => p.windowId === windowId).length, window_layout: "", window_zoomed_flag: "0", window_activity: activity.get(windowId) ?? 0
  });
  const paneVars = (p: FakePane) => ({
    ...windowVars(p.windowId), pane_id: p.id, pane_index: 0, pane_active: "1", pane_current_path: p.path, pane_current_command: p.command,
    pane_title: "", pane_pid: p.pid, pane_tty: `/dev/tty_${p.id.slice(1)}`, pane_width: p.width, pane_height: p.height, history_size: p.history
  });
  const ok = (stdout: string) => ({ status: 0, signal: null, stdout, stderr: "" });
  const client: TmuxClient = {
    socketArgs: [],
    runner: {
      run: async (_command: string, args: string[]) => {
        const format = args.includes("-F") ? args[args.indexOf("-F") + 1]! : args[args.length - 1]!;
        const target = args[args.indexOf("-t") + 1];
        switch (args[0]) {
          case "list-sessions": return ok(render(format, { session_name: "s", session_windows: activity.size, session_attached: 0, session_created_string: "" }));
          case "list-windows": return ok([...activity.keys()].map((id) => render(format, windowVars(id))).join("\n"));
          case "list-panes": return ok(panes.map((p) => render(format, paneVars(p))).join("\n"));
          case "capture-pane": {
            captures.set(target!, (captures.get(target!) ?? 0) + 1);
            beforeCapture?.(target!);
            return ok(panes.find((p) => p.id === target)!.text);
          }
          case "display-message": return ok(render(format, paneVars(panes.find((p) => p.id === target)!)));
          default: {
            // ps -t <tty>: the processes the test put on that pane's terminal.
            const tty = args[args.indexOf("-t") + 1];
            const pane = panes.find((p) => `tty_${p.id.slice(1)}` === tty);
            return ok((pane?.processes ?? []).join("\n"));
          }
        }
      }
    }
  } as unknown as TmuxClient;
  return { activity, panes, captures, client, onCapture: (fn: ((paneId: string) => void) | null) => { beforeCapture = fn; } };
}

/** A tmux with one window of one pane, quiet for a while; a cache on a clock of the test's. */
function scene() {
  const tmux = fakeTmux();
  let now = 1_800_000_000_000;
  const cache = createPaneCaptureCache({ now: () => now });
  tmux.activity.set("@1", Math.floor(now / 1000) - 120);
  tmux.panes.push({ id: "%1", windowId: "@1", width: 80, height: 24, command: "codex", path: "/work", pid: 101, history: 40, text: "ready\n" });
  const poll = (options: { forceWindowIds?: string[]; lines?: number } = {}) =>
    getRawTmuxState(options.lines ?? 20, { captureCache: cache, ...(options.forceWindowIds ? { forceWindowIds: options.forceWindowIds } : {}) }, tmux.client);
  return { ...tmux, cache, poll, pane: tmux.panes[0]!, advance: (ms: number) => { now += ms; }, second: () => Math.floor(now / 1000) };
}

test("a quiet window is captured once, then kept until tmux reports output in it", async () => {
  const s = scene();
  expect((await s.poll()).panes[0]!.capture).toBe("ready");
  s.advance(5000);
  s.pane.text = "changed, but tmux said nothing yet\n";
  const kept = await s.poll();
  expect(s.captures.get("%1")).toBe(1);
  expect(kept.panes[0]!.capture).toBe("ready");
  // Output: tmux moves the window's activity to the second it came.
  s.activity.set("@1", s.second());
  s.advance(5000);
  expect((await s.poll()).panes[0]!.capture).toBe("changed, but tmux said nothing yet");
  expect(s.captures.get("%1")).toBe(2);
});

test("output in the second of the last capture is caught: the second counts as after it", async () => {
  const s = scene();
  await s.poll();
  s.activity.set("@1", s.second());
  s.advance(5000);
  await s.poll();
  expect(s.captures.get("%1")).toBe(2);
});

test("a pane whose size, command, folder, process or history changed is captured again", async () => {
  const s = scene();
  await s.poll();
  const changes: Array<(p: FakePane) => void> = [
    (p) => { p.width = 100; }, (p) => { p.height = 30; }, (p) => { p.command = "zsh"; }, (p) => { p.path = "/other"; },
    (p) => { p.pid = 202; }, (p) => { p.history = 0; }
  ];
  for (const [i, change] of changes.entries()) {
    change(s.pane);
    s.advance(5000);
    await s.poll();
    expect(s.captures.get("%1")).toBe(i + 2);
    s.advance(5000);
    await s.poll();
    expect(s.captures.get("%1")).toBe(i + 2);
  }
});

test("a window asked for now is captured whatever its activity, and a new pane at once", async () => {
  const s = scene();
  await s.poll();
  s.advance(5000);
  await s.poll({ forceWindowIds: ["@1"] });
  expect(s.captures.get("%1")).toBe(2);
  s.panes.push({ id: "%2", windowId: "@1", width: 80, height: 24, command: "codex", path: "/work", pid: 102, history: 0, text: "second\n" });
  s.advance(5000);
  await s.poll();
  expect([s.captures.get("%1"), s.captures.get("%2")]).toEqual([2, 1]);
});

test("every pane is captured again after a minute; a change tmux reported as activity keeps it trusted", async () => {
  const s = scene();
  await s.poll();
  s.advance(PANE_REFRESH_MS);
  await s.poll();
  expect(s.captures.get("%1")).toBe(2);
  // Output just before this refresh, after the activity it read: tmux had moved it.
  s.advance(PANE_REFRESH_MS);
  s.pane.text = "late output\n";
  s.activity.set("@1", s.second() - 1);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const original = s.client.runner!.run.bind(s.client.runner);
    let listed = false;
    (s.client.runner as { run: typeof original }).run = async (command, args, options) => {
      // The activity the poll reads is from before the output.
      if (args[0] === "list-windows" && !listed) { listed = true; const was = s.activity.get("@1")!; s.activity.set("@1", was - 200); const out = await original(command, args, options); s.activity.set("@1", was); return out; }
      return original(command, args, options);
    };
    await s.poll();
    expect(s.captures.get("%1")).toBe(3);
    expect(s.cache.trustActivity).toBe(true);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
  s.advance(5000);
  await s.poll();
  expect(s.captures.get("%1")).toBe(3);
});

test("one unexplained change is let pass; a second within ten minutes makes every later poll capture every pane, said once", async () => {
  const s = scene();
  await s.poll();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    // A capture whose facts did not match it (a resize between the list and
    // the capture, undone before the next poll) shows the same way, once.
    s.advance(PANE_REFRESH_MS);
    s.pane.text = "changed with no output tmux saw\n";
    expect((await s.poll()).panes[0]!.capture).toBe("changed with no output tmux saw");
    expect(s.cache.trustActivity).toBe(true);
    s.advance(5000);
    await s.poll();
    expect(s.captures.get("%1")).toBe(2);
    // Against the capture that refresh took (it may be the spoiled one): not counted.
    s.advance(PANE_REFRESH_MS);
    s.pane.text = "changed again, still nothing reported\n";
    await s.poll();
    expect(s.cache.trustActivity).toBe(true);
    // Against a clean capture another poll took: tmux is not reporting.
    s.advance(PANE_REFRESH_MS);
    s.pane.text = "and again\n";
    await s.poll();
    expect(s.cache.trustActivity).toBe(false);
    for (let i = 0; i < 3; i++) { s.advance(5000); await s.poll(); }
    expect(s.captures.get("%1")).toBe(7);
    expect(log.mock.calls.filter((call) => String(call[0]).includes("[mandate] tmux poll:"))).toHaveLength(1);
  } finally {
    log.mockRestore();
  }
});

test("unexplained changes far apart are each let pass", async () => {
  const s = scene();
  await s.poll();
  for (let i = 0; i < 3; i++) {
    s.advance(11 * 60_000);
    s.pane.text = `odd change ${i}\n`;
    await s.poll();
    expect(s.cache.trustActivity).toBe(true);
  }
});

test("without a cache every pane is captured on every poll, and the state carries no new fields", async () => {
  const tmux = fakeTmux();
  tmux.activity.set("@1", 0);
  tmux.panes.push({ id: "%1", windowId: "@1", width: 80, height: 24, command: "codex", path: "/work", pid: 101, history: 40, text: "ready\n" });
  await getRawTmuxState(20, {}, tmux.client);
  const state = await getRawTmuxState(20, {}, tmux.client);
  expect(tmux.captures.get("%1")).toBe(2);
  expect(state.panes[0]).not.toHaveProperty("historySize");
  expect(state.windows[0]).not.toHaveProperty("windowActivity");
});

test("a pane moved into another window is captured again: one window's activity says nothing of another's", async () => {
  const s = scene();
  s.activity.set("@2", s.second() - 300);
  await s.poll();
  // Output in its window, then moved (swap-pane) into a quiet window of the same size.
  s.activity.set("@1", s.second());
  s.pane.text = "output before the move\n";
  s.pane.windowId = "@2";
  s.advance(5000);
  expect((await s.poll()).panes[0]!.capture).toBe("output before the move");
});

test("a refresh that finds the pane changed with its facts changed in the meantime keeps the activity trusted", async () => {
  const s = scene();
  await s.poll();
  s.advance(PANE_REFRESH_MS);
  // clear-history between the poll's list and its capture.
  s.onCapture(() => { s.pane.history = 0; s.pane.text = "after clear-history\n"; });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect((await s.poll()).panes[0]!.capture).toBe("after clear-history");
    expect(s.cache.trustActivity).toBe(true);
  } finally {
    log.mockRestore();
  }
});

test("a new capture depth captures every pane again", async () => {
  const s = scene();
  await s.poll({ lines: 20 });
  s.advance(5000);
  await s.poll({ lines: 40 });
  expect(s.captures.get("%1")).toBe(2);
});

test("one race seen in several panes captured in the same poll counts once", async () => {
  const s = scene();
  s.panes.push({ id: "%2", windowId: "@1", width: 40, height: 24, command: "codex", path: "/work", pid: 102, history: 10, text: "split\n" });
  await s.poll();
  // A resize between that poll's list and its captures, undone since: both
  // panes' captures disagree with their facts, found at the same refresh.
  s.advance(PANE_REFRESH_MS);
  s.pane.text = "first pane, odd\n";
  s.panes[1]!.text = "second pane, odd\n";
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await s.poll();
    expect(s.cache.trustActivity).toBe(true);
    // Their refresh captures may be the spoiled ones: a change against them is not counted.
    s.advance(PANE_REFRESH_MS);
    s.pane.text = "first pane, odd again\n";
    await s.poll();
    expect(s.cache.trustActivity).toBe(true);
    // A change against a clean capture another poll took: tmux is not reporting.
    s.advance(PANE_REFRESH_MS);
    s.pane.text = "first pane, odd a third time\n";
    await s.poll();
    expect(s.cache.trustActivity).toBe(false);
  } finally {
    log.mockRestore();
  }
});

test("a refresh capture spoiled by a passing resize is not counted again when the pane looks as before", async () => {
  const s = scene();
  await s.poll();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    // At the refresh a resize comes after the list and is undone before the
    // facts are read again: the capture shows the resized pane.
    s.advance(PANE_REFRESH_MS);
    s.onCapture(() => { s.pane.text = "reflowed while resized\n"; });
    await s.poll();
    expect(s.cache.trustActivity).toBe(true);
    // The next refresh sees the pane as it was: the same passing resize.
    s.onCapture(null);
    s.pane.text = "ready\n";
    s.advance(PANE_REFRESH_MS);
    expect((await s.poll()).panes[0]!.capture).toBe("ready");
    expect(s.cache.trustActivity).toBe(true);
  } finally {
    log.mockRestore();
  }
});

test("a kept pane's processes are still read on every poll: a child can end without output", async () => {
  const s = scene();
  s.pane.processes = ["101 1 Ss codex", "202 101 R+ cargo test"];
  expect((await s.poll()).panes[0]!.foregroundProcesses.map((p) => p.pid)).toEqual([202]);
  s.pane.processes = ["101 1 S+ codex"];
  s.advance(5000);
  const later = await s.poll();
  expect(s.captures.get("%1")).toBe(1);
  expect(later.panes[0]!.foregroundProcesses.map((p) => p.pid)).toEqual([101]);
});

// capture-pane -e keeps spaces that carry a colour (a TUI's background), so a
// capture can hold a long run of them before more text; `/\s+$/g` backtracked
// quadratically over such a run.
test("a captured pane is trimmed in linear time, however long a run of spaces inside it", async () => {
  const capture = `\x1b[44m${" ".repeat(131_072)}\x1b[0mstatus line  \n\n`;
  const client: TmuxClient = { socketArgs: [], runner: { run: async () => ({ status: 0, signal: null, stdout: capture, stderr: "" }) } };
  const started = performance.now();
  const preview = await capturePanePreview("%1", 10, client);
  expect(performance.now() - started).toBeLessThan(500);
  expect(preview).toBe(`${" ".repeat(131_072)}status line`);
}, 60_000);

test("captureStaggerDelayMs keeps the first pane immediate and staggers later captures", () => {
  expect(captureStaggerDelayMs(0, () => 1)).toBe(0);
  expect(captureStaggerDelayMs(1, () => 0)).toBe(0);
  expect(captureStaggerDelayMs(1, () => 0.5)).toBe(20);
});
