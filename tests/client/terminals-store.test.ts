import { afterEach, expect, test } from "bun:test";
import { toast } from "sonner";
import { readTerminalsIfNeeded, startTerminalsPolling, useTerminalsStore } from "@/store/terminals";
import { onCleanup } from "../helpers/cleanup.js";

afterEach(() => { useTerminalsStore.setState({ sessions: null, pins: [], status: "idle", error: null, latest: 0, applied: 0, listApplied: 0 }); });

type Answer = { status: number; body: unknown };
/** fetch, answered by the test in the order it chooses. */
function deferredFetch() {
  const calls: Array<{ url: string; init?: RequestInit; answer: (a: Answer) => void }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
    calls.push({ url: String(url), init, answer: (a) => resolve(new Response(JSON.stringify(a.body), { status: a.status })) });
  })) as typeof fetch;
  onCleanup(() => { globalThis.fetch = original; });
  return calls;
}
function errorToasts() {
  const shown: Array<[string, string | undefined]> = [];
  const original = toast.error;
  toast.error = ((message: unknown, data?: { description?: string }) => { shown.push([String(message), data?.description]); return ""; }) as typeof toast.error;
  onCleanup(() => { toast.error = original; });
  return shown;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const PIN = (paneId: string) => ({ paneId, pid: 101, pinnedAt: "2026-11-13T00:00:00.000Z" });

test("a pin's answer is kept over a list read sent before it", async () => {
  const calls = deferredFetch();
  const read = useTerminalsStore.getState().refresh();
  const pin = useTerminalsStore.getState().pin("%1", 101);
  await tick();
  calls[1]!.answer({ status: 200, body: { pins: [PIN("%1")] } });
  await pin;
  calls[0]!.answer({ status: 200, body: { sessions: [], pins: [] } });
  await read;
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%1"]);
  expect(useTerminalsStore.getState().sessions).toEqual([]);
});

test("a list read the server answered before a pending pin does not undo the pin, and the list is read again after", async () => {
  const calls = deferredFetch();
  const pin = useTerminalsStore.getState().pin("%1", 101);
  const read = useTerminalsStore.getState().refresh();
  await tick();
  calls[1]!.answer({ status: 200, body: { sessions: [], pins: [] } });
  await read;
  calls[0]!.answer({ status: 200, body: { pins: [PIN("%1")] } });
  await pin;
  await tick();
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%1"]);
  // The read that came back meanwhile is made good by one more.
  expect(calls.map((c) => c.init?.method ?? "GET")).toEqual(["POST", "GET", "GET"]);
});

test("a list read sent while a pin was on its way, answered after it, does not undo the pin", async () => {
  const calls = deferredFetch();
  const pin = useTerminalsStore.getState().pin("%1", 101);
  const read = useTerminalsStore.getState().refresh();
  await tick();
  calls[0]!.answer({ status: 200, body: { pins: [PIN("%1")] } });
  await pin;
  calls[1]!.answer({ status: 200, body: { sessions: [], pins: [] } });
  await read;
  await tick();
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%1"]);
  expect(calls.map((c) => c.init?.method ?? "GET")).toEqual(["POST", "GET", "GET"]);
});

test("an older list reply does not replace a newer one", async () => {
  const calls = deferredFetch();
  const older = useTerminalsStore.getState().refresh();
  const newer = useTerminalsStore.getState().refresh();
  await tick();
  const session = { name: "work", ownership: "unmanaged", projectId: null, projectName: null, windows: [] };
  calls[1]!.answer({ status: 200, body: { sessions: [session], pins: [] } });
  await newer;
  calls[0]!.answer({ status: 200, body: { sessions: [], pins: [] } });
  await older;
  expect(useTerminalsStore.getState().sessions?.map((s) => s.name)).toEqual(["work"]);
});

test("a pin that fails says so in its fixed words", async () => {
  const calls = deferredFetch();
  const shown = errorToasts();
  const pin = useTerminalsStore.getState().pin("%1", 101);
  await tick();
  calls[0]!.answer({ status: 404, body: { error: "pane not found" } });
  await pin;
  expect(shown).toEqual([["Couldn't pin this terminal.", "pane not found"]]);
});

test("an unpin that fails says so", async () => {
  const calls = deferredFetch();
  const shown = errorToasts();
  const unpin = useTerminalsStore.getState().unpin("%1");
  await tick();
  expect(calls[0]!.url).toContain("/api/terminals/pins/%251");
  calls[0]!.answer({ status: 404, body: { error: "pin not found" } });
  await unpin;
  expect(shown).toEqual([["Couldn't unpin this terminal.", "pin not found"]]);
});

test("a new terminal returns its pane, or says why it could not open one", async () => {
  const calls = deferredFetch();
  const shown = errorToasts();
  const ok = useTerminalsStore.getState().openShell();
  await tick();
  calls[0]!.answer({ status: 200, body: { paneId: "%7", pid: 4242 } });
  expect(await ok).toEqual({ paneId: "%7", pid: 4242 });
  // A shell made reads the list again, so its tab can name it.
  expect(calls.map((c) => c.init?.method ?? "GET")).toEqual(["POST", "GET"]);
  const bad = useTerminalsStore.getState().openShell();
  await tick();
  calls[2]!.answer({ status: 500, body: { error: "tmux new-window failed (status 1)" } });
  expect(await bad).toBeNull();
  expect(shown).toEqual([["Couldn't open a new terminal.", "tmux new-window failed (status 1)"]]);
});

test("polling reads every interval while the page is visible, and not while hidden", () => {
  let visible = true;
  let tickFn: (() => void) | null = null;
  let reads = 0;
  const stop = startTerminalsPolling({
    read: () => { reads += 1; },
    visible: () => visible,
    every: (fn) => { tickFn = fn; return () => { tickFn = null; }; }
  });
  expect(reads).toBe(1);
  tickFn!();
  expect(reads).toBe(2);
  visible = false;
  tickFn!();
  expect(reads).toBe(2);
  stop();
  expect(tickFn).toBeNull();
});

test("a first read that failed is tried again by the next place that needs the list; one that worked is not", async () => {
  const calls = deferredFetch();
  readTerminalsIfNeeded();
  await tick();
  calls[0]!.answer({ status: 503, body: { error: "down" } });
  await tick(); await tick();
  readTerminalsIfNeeded();
  await tick();
  expect(calls).toHaveLength(2);
  calls[1]!.answer({ status: 200, body: { sessions: [], pins: [] } });
  await tick(); await tick();
  readTerminalsIfNeeded();
  await tick();
  expect(calls).toHaveLength(2);
});

// Pins dragged into another order: shown at once, then saved; a failure says
// so and reads the pins again.
const PINNED = (paneId: string, pid: number) => ({ paneId, pid, pinnedAt: "2026-11-13T00:00:00.000Z" });

test("reorderPins shows the new order at once and keeps it when the server agrees", async () => {
  const calls = deferredFetch();
  useTerminalsStore.setState({ pins: [PINNED("%1", 101), PINNED("%2", 102)] });
  const moved = useTerminalsStore.getState().reorderPins([{ paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }]);
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%1"]);
  await tick();
  expect(calls[0]!.url).toContain("/api/terminals/pins/order");
  expect(calls[0]!.init?.method).toBe("PUT");
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ pins: [{ paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }] });
  calls[0]!.answer({ status: 200, body: { pins: [PINNED("%2", 102), PINNED("%1", 101)] } });
  await moved;
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%1"]);
});

test("a list read sent before a reorder and answered after it does not undo it", async () => {
  const calls = deferredFetch();
  useTerminalsStore.setState({ pins: [PINNED("%1", 101), PINNED("%2", 102)] });
  const read = useTerminalsStore.getState().refresh();
  const moved = useTerminalsStore.getState().reorderPins([{ paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }]);
  await tick();
  calls[0]!.answer({ status: 200, body: { sessions: [], pins: [PINNED("%1", 101), PINNED("%2", 102)] } });
  await read;
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%1"]);
  calls[1]!.answer({ status: 200, body: { pins: [PINNED("%2", 102), PINNED("%1", 101)] } });
  await moved;
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%1"]);
});

test("a reorder the server refuses says Couldn't move this terminal. and reads the pins again, so the order goes back", async () => {
  const calls = deferredFetch();
  const shown = errorToasts();
  useTerminalsStore.setState({ sessions: [], pins: [PINNED("%1", 101), PINNED("%2", 102)] });
  const moved = useTerminalsStore.getState().reorderPins([{ paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }]);
  await tick();
  calls[0]!.answer({ status: 500, body: { error: "disk full" } });
  await moved;
  expect(shown).toEqual([["Couldn't move this terminal.", "disk full"]]);
  await tick();
  expect(calls[1]!.init?.method ?? "GET").toBe("GET");
  calls[1]!.answer({ status: 200, body: { sessions: [], pins: [PINNED("%1", 101), PINNED("%2", 102)] } });
  await tick();
  await tick();
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%1", "%2"]);
});

// Two quick moves are saved one after the other, so the later order is the one
// the server keeps.
test("a second reorder made while the first is being saved is sent after it, with the latest order", async () => {
  const calls = deferredFetch();
  useTerminalsStore.setState({ pins: [PINNED("%1", 101), PINNED("%2", 102), PINNED("%3", 103)] });
  const first = useTerminalsStore.getState().reorderPins([{ paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }, { paneId: "%3", pid: 103 }]);
  const second = useTerminalsStore.getState().reorderPins([{ paneId: "%2", pid: 102 }, { paneId: "%3", pid: 103 }, { paneId: "%1", pid: 101 }]);
  await tick();
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%3", "%1"]);
  expect(calls).toHaveLength(1);
  calls[0]!.answer({ status: 200, body: { pins: [PINNED("%2", 102), PINNED("%1", 101), PINNED("%3", 103)] } });
  await first;
  await tick();
  // The first save's answer is older than what is shown: kept out.
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%3", "%1"]);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[1]!.init?.body)).pins.map((p: { paneId: string }) => p.paneId)).toEqual(["%2", "%3", "%1"]);
  calls[1]!.answer({ status: 200, body: { pins: [PINNED("%2", 102), PINNED("%3", 103), PINNED("%1", 101)] } });
  await second;
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%3", "%1"]);
});

// A list read that comes back while pin orders are still queued is read again
// only once the last is saved; the server's answer to the latest move is the
// pins shown.
test("a list read answered while two moves are queued is read again only after the second is saved", async () => {
  const calls = deferredFetch();
  useTerminalsStore.setState({ sessions: [], pins: [PINNED("%1", 101), PINNED("%2", 102), PINNED("%3", 103)] });
  const first = useTerminalsStore.getState().reorderPins([{ paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }, { paneId: "%3", pid: 103 }]);
  const second = useTerminalsStore.getState().reorderPins([{ paneId: "%2", pid: 102 }, { paneId: "%3", pid: 103 }, { paneId: "%1", pid: 101 }]);
  await tick();
  // Another device's change: the pins read again meanwhile, answered before the first save.
  const read = useTerminalsStore.getState().refresh();
  await tick();
  calls[1]!.answer({ status: 200, body: { sessions: [], pins: [PINNED("%1", 101), PINNED("%2", 102), PINNED("%3", 103)] } });
  await read;
  calls[0]!.answer({ status: 200, body: { pins: [PINNED("%2", 102), PINNED("%1", 101), PINNED("%3", 103)] } });
  await first;
  await tick();
  expect(calls.map((c) => c.init?.method ?? "GET")).toEqual(["PUT", "GET", "PUT"]);
  calls[2]!.answer({ status: 200, body: { pins: [PINNED("%2", 102), PINNED("%3", 103), PINNED("%1", 101)] } });
  await second;
  await tick();
  expect(calls.map((c) => c.init?.method ?? "GET")).toEqual(["PUT", "GET", "PUT", "GET"]);
  calls[3]!.answer({ status: 200, body: { sessions: [], pins: [PINNED("%2", 102), PINNED("%3", 103), PINNED("%1", 101)] } });
  await tick();
  await tick();
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%3", "%1"]);
});

test("the server's answer to the latest move is shown: a pin another device took away goes", async () => {
  const calls = deferredFetch();
  useTerminalsStore.setState({ pins: [PINNED("%1", 101), PINNED("%2", 102), PINNED("%3", 103)] });
  const moved = useTerminalsStore.getState().reorderPins([{ paneId: "%2", pid: 102 }, { paneId: "%1", pid: 101 }, { paneId: "%3", pid: 103 }]);
  await tick();
  calls[0]!.answer({ status: 200, body: { pins: [PINNED("%2", 102), PINNED("%1", 101)] } });
  await moved;
  expect(useTerminalsStore.getState().pins.map((p) => p.paneId)).toEqual(["%2", "%1"]);
});
