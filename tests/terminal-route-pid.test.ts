import { afterEach, expect, setSystemTime, test } from "bun:test";
import { openTerminalViewer } from "../src/server/modules/panes/terminal-route.js";

const PARAMS = { cols: 80, rows: 24, fit: false, historyRows: 1000 };

function fakes(livePid: number | null) {
  const closed: Array<[number, string]> = [];
  const attached: string[] = [];
  const frames: unknown[] = [];
  let resolvePid!: (pid: number | null) => void;
  const ws = { close: (code: number, reason: string) => { closed.push([code, reason]); } } as never;
  const deps = {
    tmuxRuntime: {
      attachViewer: (paneId: string) => {
        attached.push(paneId);
        return { handleMessage: async (data: unknown) => { frames.push(data); }, detach: () => {} };
      }
    } as never,
    panePid: () => new Promise<number | null>((resolve) => { resolvePid = resolve; })
  };
  return { ws, deps, closed, attached, frames, answer: () => resolvePid(livePid) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a pid that matches attaches and frames sent before the attach arrive in order", async () => {
  const f = fakes(4242);
  const viewer = openTerminalViewer({ paneId: "%7", expectPid: 4242, ...PARAMS }, f.ws, f.deps);
  viewer.handleMessage("a");
  viewer.handleMessage("b");
  f.answer();
  await settle();
  viewer.handleMessage("c");
  await settle();
  expect(f.attached).toEqual(["%7"]);
  expect(f.frames).toEqual(["a", "b", "c"]);
  expect(f.closed).toEqual([]);
});

test("a pid that does not match closes with 4404 and attaches nothing", async () => {
  const f = fakes(5000);
  const viewer = openTerminalViewer({ paneId: "%7", expectPid: 4242, ...PARAMS }, f.ws, f.deps);
  viewer.handleMessage("typed");
  f.answer();
  await settle();
  expect(f.closed).toEqual([[4404, "pane closed"]]);
  expect(f.attached).toEqual([]);
  expect(f.frames).toEqual([]);
});

test("a pane that is gone closes with 4404", async () => {
  const f = fakes(null);
  openTerminalViewer({ paneId: "%7", expectPid: 4242, ...PARAMS }, f.ws, f.deps);
  f.answer();
  await settle();
  expect(f.closed).toEqual([[4404, "pane closed"]]);
});

test("no pid attaches as today", () => {
  const f = fakes(4242);
  openTerminalViewer({ paneId: "%7", expectPid: null, ...PARAMS }, f.ws, f.deps);
  expect(f.attached).toEqual(["%7"]);
});

/** A pane whose pid tmux gives, in turn, from `answers`; each lookup waits for `answer()`. */
function changing(answers: Array<number | null>) {
  const closed: Array<[number, string]> = [];
  const frames: unknown[] = [];
  let detached = 0;
  let asked = 0;
  const pending: Array<() => void> = [];
  const ws = { close: (code: number, reason: string) => { closed.push([code, reason]); } } as never;
  const deps = {
    tmuxRuntime: {
      attachViewer: () => ({ handleMessage: async (data: unknown) => { frames.push(data); }, detach: () => { detached += 1; } })
    } as never,
    panePid: () => {
      const pid = answers[asked++] ?? null;
      return new Promise<number | null>((resolve) => { pending.push(() => resolve(pid)); });
    }
  };
  return { ws, deps, closed, frames, asked: () => asked, detached: () => detached, answer: () => pending.shift()!() };
}

afterEach(() => { setSystemTime(); });

test("an open terminal typed into after a pause asks tmux again; the same pid lets the keys through in order", async () => {
  setSystemTime(new Date("2026-11-13T10:00:00Z"));
  const f = changing([4242, 4242]);
  const viewer = openTerminalViewer({ paneId: "%7", expectPid: 4242, ...PARAMS }, f.ws, f.deps);
  f.answer();
  await settle();
  viewer.handleMessage("a");
  await settle();
  expect(f.asked()).toBe(1);
  setSystemTime(new Date("2026-11-13T10:00:02Z"));
  viewer.handleMessage("b");
  viewer.handleMessage("c");
  await settle();
  expect(f.frames).toEqual(["a"]);
  expect(f.asked()).toBe(2);
  f.answer();
  await settle();
  expect(f.frames).toEqual(["a", "b", "c"]);
  expect(f.closed).toEqual([]);
});

test("an open terminal whose pane id another process took (tmux restarted) closes with 4404 before a key reaches it", async () => {
  setSystemTime(new Date("2026-11-13T10:00:00Z"));
  const f = changing([4242, 5000]);
  const viewer = openTerminalViewer({ paneId: "%7", expectPid: 4242, ...PARAMS }, f.ws, f.deps);
  f.answer();
  await settle();
  setSystemTime(new Date("2026-11-13T10:00:05Z"));
  viewer.handleMessage("rm -rf build\r");
  await settle();
  f.answer();
  await settle();
  expect(f.frames).toEqual([]);
  expect(f.closed).toEqual([[4404, "pane closed"]]);
  expect(f.detached()).toBe(1);
  viewer.handleMessage("more");
  await settle();
  expect(f.frames).toEqual([]);
  expect(f.asked()).toBe(2);
});

test("keys waiting on a recheck when the viewer leaves still reach the pane once tmux says it is the same one", async () => {
  setSystemTime(new Date("2026-11-13T10:00:00Z"));
  const f = changing([4242, 4242]);
  const viewer = openTerminalViewer({ paneId: "%7", expectPid: 4242, ...PARAMS }, f.ws, f.deps);
  f.answer();
  await settle();
  setSystemTime(new Date("2026-11-13T10:00:03Z"));
  viewer.handleMessage("make test");
  viewer.handleMessage("\r");
  viewer.detach();
  expect(f.detached()).toBe(1);
  f.answer();
  await settle();
  expect(f.frames).toEqual(["make test", "\r"]);
  expect(f.closed).toEqual([]);
});

test("keys waiting on a recheck when the viewer leaves are dropped if another process has the pane id", async () => {
  setSystemTime(new Date("2026-11-13T10:00:00Z"));
  const f = changing([4242, 5000]);
  const viewer = openTerminalViewer({ paneId: "%7", expectPid: 4242, ...PARAMS }, f.ws, f.deps);
  f.answer();
  await settle();
  setSystemTime(new Date("2026-11-13T10:00:03Z"));
  viewer.handleMessage("make test\r");
  viewer.detach();
  f.answer();
  await settle();
  expect(f.frames).toEqual([]);
});

test("an Auto socket come back attaches with its resume, decided before the first paint", () => {
  const options: unknown[] = [];
  const deps = {
    tmuxRuntime: {
      attachViewer: (_paneId: string, _ws: unknown, _size: unknown, opts: unknown) => {
        options.push(opts);
        return { handleMessage: async () => {}, detach: () => {} };
      }
    } as never,
    panePid: async () => 4242
  };
  const ws = { close: () => {} } as never;
  openTerminalViewer({ paneId: "%7", expectPid: null, ...PARAMS, fit: true, auto: true, resume: true }, ws, deps);
  expect(options).toEqual([{ fit: true, auto: true, resume: true, historyRows: 1000 }]);
});
