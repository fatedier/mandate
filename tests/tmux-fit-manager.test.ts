import { expect, test } from "bun:test";
import type { WSContext } from "hono/ws";
import type { CommandResult, CommandRunner } from "../src/server/platform/process/command-runner.js";
import { TmuxFitManager } from "../src/server/runtime/runtimes/tmux-fit-manager.js";
import { TMUX_FIELD_SEP } from "../src/server/runtime/runtimes/tmux-runtime-constants.js";

const SEP = TMUX_FIELD_SEP;
const ok = (stdout = ""): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });

/** A tmux with one window @1 of two panes, %1 active, answering what the
 *  fit manager asks; `windowSize` is the window's own window-size option
 *  ("" when it has none), `clients` the list-clients lines. */
function scriptedTmux(opts: { windowSize?: string; clients?: () => string[] } = {}) {
  const calls: string[][] = [];
  let zoomed = false;
  const runner: CommandRunner = {
    async run(_command, args) {
      calls.push(args);
      const [sub] = args;
      if (sub === "display-message" && args.at(-1) === "#{window_zoomed_flag} #{pane_id}") return ok(`${zoomed ? 1 : 0} %1\n`);
      if (sub === "display-message" && args.at(-1) === `#{pane_width}${SEP}#{pane_height}`) return ok(`96${SEP}43\n`);
      if (sub === "display-message") return ok(["@1", "a1b2,160x44,0,0{96x44,0,0,1,63x44,97,0,2}", "0", "160", "44"].join(SEP) + "\n");
      if (sub === "list-panes") return ok([`%1${SEP}1`, `%2${SEP}0`].join("\n") + "\n");
      if (sub === "show-options") return ok(opts.windowSize ? `${opts.windowSize}\n` : "");
      if (sub === "list-clients") return ok((opts.clients?.() ?? []).join("\n") + "\n");
      if (sub === "resize-pane" && args.includes("-Z")) zoomed = !zoomed;
      return ok();
    }
  };
  return { client: { socketArgs: [], runner }, calls };
}

const ws = (name: string) => ({ name }) as unknown as WSContext;
const size = { cols: 47, rows: 36 };
const client = (control: 0 | 1, windowId: string, activitySeconds: number) => [String(control), windowId, String(activitySeconds)].join(SEP);

test("a window given back takes its size from tmux again: its own window-size option, which resizing set, is unset", async () => {
  const tmux = scriptedTmux();
  const fits = new TmuxFitManager({ tmuxClient: tmux.client });
  const viewer = ws("phone");
  await fits.applyFit("%1", viewer, size);
  await fits.releaseClient(viewer, true, 0);
  const restoreFrom = tmux.calls.findIndex((c, i) => i > 0 && c[0] === "resize-window" && c.includes("160"));
  expect(restoreFrom).toBeGreaterThan(0);
  expect(tmux.calls.slice(restoreFrom)).toContainEqual(["set-option", "-w", "-u", "-t", "@1", "window-size"]);
});

test("a window that had its own window-size option gets that one back", async () => {
  const tmux = scriptedTmux({ windowSize: "largest" });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client });
  const viewer = ws("phone");
  await fits.applyFit("%1", viewer, size);
  await fits.releaseClient(viewer, true, 0);
  expect(tmux.calls).toContainEqual(["set-option", "-w", "-t", "@1", "window-size", "largest"]);
  expect(tmux.calls).not.toContainEqual(["set-option", "-w", "-u", "-t", "@1", "window-size"]);
});

test("a window held for Auto goes back to the terminal on it that was used since: given back as it was, its holder named", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 999)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const viewer = ws("phone");
  await fits.applyFit("%1", viewer, size, { auto: true });
  // Its activity before the fit was asked for: the phone is the latest.
  expect(await fits.yieldToActiveClients()).toEqual([]);
  expect(fits.hasClientLease(viewer, "%1")).toBe(true);
  // A key pressed on the desk's terminal after.
  now = 1_003_000;
  clients[0] = client(0, "@1", 1_002);
  // Named with the pane's size as given back, for its view to take before
  // anything is painted for it.
  expect(await fits.yieldToActiveClients()).toEqual([{ ws: viewer, paneId: "%1", size: { cols: 96, rows: 43 } }]);
  expect(fits.hasClientLease(viewer, "%1")).toBe(false);
  expect(tmux.calls).toContainEqual(["set-option", "-w", "-u", "-t", "@1", "window-size"]);
});

test("used again after the desk's key, the web keeps the window", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 1_001)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const viewer = ws("phone");
  await fits.applyFit("%1", viewer, size, { auto: true });
  now = 1_002_000;
  await fits.applyFit("%1", viewer, size, { auto: true, keep: true });
  expect(await fits.yieldToActiveClients()).toEqual([]);
  // Asked again at its size (a tap, the page shown again): the same.
  clients[0] = client(0, "@1", 1_003);
  now = 1_004_000;
  await fits.applyFit("%1", viewer, size, { auto: true, keep: true });
  expect(await fits.yieldToActiveClients()).toEqual([]);
});

test("only a terminal showing that window counts, never a control client, and only for viewers on Auto", async () => {
  let now = 1_000_000;
  const clients = [client(1, "@1", 5_000), client(0, "@7", 5_000)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const auto = ws("phone");
  await fits.applyFit("%1", auto, size, { auto: true });
  now = 1_001_000;
  expect(await fits.yieldToActiveClients()).toEqual([]);
  // Held for "This screen": the desk's key does not take it.
  const screen = ws("laptop");
  await fits.applyFit("%1", screen, size);
  clients.push(client(0, "@1", 5_000));
  expect(await fits.yieldToActiveClients()).toEqual([]);
  expect(fits.hasClientLease(screen, "%1")).toBe(true);
});

test("with no window held for Auto, tmux is not asked about its clients", async () => {
  const tmux = scriptedTmux({ clients: () => [client(0, "@1", 9_999_999)] });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client });
  await fits.applyFit("%1", ws("laptop"), size);
  await fits.yieldToActiveClients();
  expect(tmux.calls.some((c) => c[0] === "list-clients")).toBe(false);
});

test("the holders of a window given back are named before tmux is asked to change it, so their output can stop first", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 999)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const viewer = ws("phone");
  await fits.applyFit("%1", viewer, size, { auto: true });
  now = 1_003_000;
  clients[0] = client(0, "@1", 1_002);
  let callsWhenNamed = -1;
  const named: unknown[] = [];
  await fits.yieldToActiveClients((holders, paneId) => { callsWhenNamed = tmux.calls.length; named.push(holders, paneId); });
  expect(named).toEqual([[viewer], "%1"]);
  // Nothing restored yet when they were named: the restore's layout and option come after.
  const restoring = (c: string[]) => c[0] === "select-layout" || c[0] === "set-option";
  expect(tmux.calls.slice(0, callsWhenNamed).filter(restoring)).toEqual([]);
  expect(tmux.calls.slice(callsWhenNamed).filter(restoring).length).toBeGreaterThan(0);
});

test("a window given back to an Auto viewer another pane's viewer took it from keeps that viewer's own last use, not the moment it came back", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 999)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const phone = ws("phone");
  await fits.applyFit("%1", phone, size, { auto: true });
  now = 1_001_000;
  const laptop = ws("laptop");
  await fits.applyFit("%2", laptop, { cols: 100, rows: 30 }, { auto: true });
  // The desk's terminal used after both asked; then the laptop lets go.
  clients[0] = client(0, "@1", 1_002);
  now = 1_003_000;
  await fits.releaseClient(laptop, true, 0);
  expect(fits.hasClientLease(phone, "%1")).toBe(true);
  // Nobody used the phone since: the desk's key, later, takes it.
  expect(await fits.yieldToActiveClients()).toEqual([{ ws: phone, paneId: "%1", size: { cols: 96, rows: 43 } }]);
});

test("a window two Auto viewers hold for two of its panes (one took it from the other) goes back too, both named with their panes' sizes", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 999)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const phone = ws("phone");
  const laptop = ws("laptop");
  await fits.applyFit("%1", phone, size, { auto: true });
  now = 1_001_000;
  await fits.applyFit("%2", laptop, { cols: 100, rows: 30 }, { auto: true });
  clients[0] = client(0, "@1", 1_002);
  now = 1_003_000;
  const named: Array<[WSContext[], string]> = [];
  expect(await fits.yieldToActiveClients((holders, paneId) => { named.push([holders, paneId]); })).toEqual([
    { ws: laptop, paneId: "%2", size: { cols: 96, rows: 43 } },
    { ws: phone, paneId: "%1", size: { cols: 96, rows: 43 } }
  ]);
  expect(named).toEqual([[[laptop], "%2"], [[phone], "%1"]]);
  expect([fits.hasClientLease(phone, "%1"), fits.hasClientLease(laptop, "%2")]).toEqual([false, false]);
});

test("given back, a resume on Auto (a socket come back) takes nothing and says so; a use takes it again, and resumes then fit", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 999)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const phone = ws("phone");
  await fits.applyFit("%1", phone, size, { auto: true });
  now = 1_003_000;
  clients[0] = client(0, "@1", 1_002);
  await fits.yieldToActiveClients();
  const reopened = ws("phone, its socket back");
  expect(await fits.applyFit("%1", reopened, size, { auto: true, resume: true })).toEqual({ type: "given-back", size: { cols: 96, rows: 43 } });
  expect(fits.hasClientLease(reopened, "%1")).toBe(false);
  // Used: fitted, and the window the web's again.
  now = 1_004_000;
  expect(await fits.applyFit("%1", reopened, size, { auto: true })).toEqual({ type: "fit", size });
  const again = ws("phone, back once more");
  await fits.releaseClient(reopened, true, 0);
  expect(await fits.applyFit("%1", again, size, { auto: true, resume: true })).toEqual({ type: "fit", size });
});

test("a resume after its socket was long gone takes no window a terminal on it used since the web last did, nor one another viewer holds", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 999)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const phone = ws("phone");
  await fits.applyFit("%1", phone, size, { auto: true });
  // The socket gone past the grace: the window put back as it was.
  await fits.releaseClient(phone, true, 0);
  // The desk's terminal used meanwhile; then the socket back.
  clients[0] = client(0, "@1", 1_002);
  now = 1_005_000;
  const back = ws("phone, back");
  expect(await fits.applyFit("%1", back, size, { auto: true, resume: true })).toEqual({ type: "given-back", size: { cols: 96, rows: 43 } });
  // Another pane's viewer holds it: a resume does not take it either.
  const laptop = ws("laptop");
  await fits.applyFit("%2", laptop, { cols: 100, rows: 30 }, { auto: true });
  clients[0] = client(0, "@1", 999);
  expect((await fits.applyFit("%1", back, size, { auto: true, resume: true }))?.type).toBe("given-back");
  expect(fits.hasClientLease(laptop, "%2")).toBe(true);
});

test("a resume with no terminal used since takes the window back as last used: a terminal used after that, though before the resume, still takes it", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 990)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now });
  const phone = ws("phone");
  await fits.applyFit("%1", phone, size, { auto: true });
  await fits.releaseClient(phone, true, 0);
  now = 1_005_000;
  const back = ws("phone, back");
  expect(await fits.applyFit("%1", back, size, { auto: true, resume: true })).toEqual({ type: "fit", size });
  // A key on the desk after the phone's last use (1 000 s), before the resume (1 005 s).
  clients[0] = client(0, "@1", 1_003);
  expect(await fits.yieldToActiveClients()).toEqual([{ ws: back, paneId: "%1", size: { cols: 96, rows: 43 } }]);
});

test("a resume with no record of the web's last use (the server started since) takes nothing", async () => {
  const tmux = scriptedTmux({ clients: () => [client(0, "@1", 999)] });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client });
  expect((await fits.applyFit("%1", ws("phone, back"), size, { auto: true, resume: true }))?.type).toBe("given-back");
});

test("a resume within the restore's grace takes the window its socket left, as last used", async () => {
  let now = 1_000_000;
  const clients = [client(0, "@1", 990)];
  const tmux = scriptedTmux({ clients: () => clients });
  const fits = new TmuxFitManager({ tmuxClient: tmux.client, now: () => now, restoreDelayMs: 60_000 });
  const phone = ws("phone");
  await fits.applyFit("%1", phone, size, { auto: true });
  // Gone, the window not put back yet (the grace): nobody holds it.
  await fits.releaseClient(phone);
  now = 1_000_300;
  const back = ws("phone, back");
  expect(await fits.applyFit("%1", back, size, { auto: true, resume: true })).toEqual({ type: "fit", size });
  // Its last use stays the phone's: a key after it takes the window.
  clients[0] = client(0, "@1", 1_000);
  now = 1_002_000;
  clients[0] = client(0, "@1", 1_001);
  expect((await fits.yieldToActiveClients()).map((y) => y.ws)).toEqual([back]);
});
