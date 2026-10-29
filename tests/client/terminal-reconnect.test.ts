import { describe, expect, test } from "bun:test";
import {
  connectTerminal,
  TERMINAL_HEALTHY_AFTER_MS,
  TERMINAL_RECONNECT_DELAYS_MS,
  type TerminalConnectionStatus,
  type TerminalSocket
} from "../../src/client/hooks/terminal/terminal-reconnect.js";

class FakeSocket implements TerminalSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closedWith: number | null = null;
  constructor(readonly attempt: number) {}
  open() { this.readyState = 1; this.onopen?.({} as Event); }
  drop(code = 1006) { this.readyState = 3; this.onerror?.({} as Event); this.onclose?.({ code } as CloseEvent); }
  close(code?: number) { this.closedWith = code ?? null; this.readyState = 3; }
}

/** Timers that only fire when the test says so, in due order. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      set: (callback: () => void, ms: number) => { const id = nextId++; pending.set(id, { at: now + ms, callback }); return id; },
      clear: (handle: unknown) => { pending.delete(handle as number); }
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    pendingDelays: () => [...pending.values()].map((t) => t.at - now)
  };
}

function setup() {
  const clock = manualTimers();
  const sockets: FakeSocket[] = [];
  const statuses: TerminalConnectionStatus[] = [];
  const opened: number[] = [];
  const connection = connectTerminal({
    open: (attempt) => { const socket = new FakeSocket(attempt); sockets.push(socket); return socket; },
    onOpen: (_socket, attempt) => opened.push(attempt),
    onStatus: (status) => statuses.push(status),
    timers: clock.timers
  });
  const last = () => sockets.at(-1)!;
  return { clock, sockets, statuses, opened, connection, last };
}

describe("connectTerminal", () => {
  test("the first socket opens as attempt 0 and reports connecting, then connected", () => {
    const { sockets, statuses, opened, last } = setup();
    last().open();
    expect(sockets.map((s) => s.attempt)).toStrictEqual([0]);
    expect(statuses).toStrictEqual(["connecting", "connected"]);
    expect(opened).toStrictEqual([0]);
  });

  test("an unexpected close reconnects after the first backoff step", () => {
    const { clock, sockets, statuses, opened, last } = setup();
    last().open();
    last().drop(1006);
    expect(statuses.at(-1)).toBe("reconnecting");
    clock.advance(TERMINAL_RECONNECT_DELAYS_MS[0] - 1);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets.map((s) => s.attempt)).toStrictEqual([0, 1]);
    last().open();
    expect(statuses.at(-1)).toBe("connected");
    expect(opened).toStrictEqual([0, 1]);
  });

  test("consecutive failures back off, and the last step repeats", () => {
    const { clock, last } = setup();
    const waits: number[] = [];
    for (let i = 0; i < TERMINAL_RECONNECT_DELAYS_MS.length + 2; i++) {
      last().drop(1006);
      const [wait] = clock.pendingDelays();
      waits.push(wait!);
      clock.advance(wait!);
    }
    expect(waits).toStrictEqual([...TERMINAL_RECONNECT_DELAYS_MS, 10_000, 10_000]);
  });

  test("a socket that opens and closes at once does not reset the backoff", () => {
    // A server that accepts and then fails the attach every time must not be
    // hit twice a second forever.
    const { clock, last } = setup();
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      last().open();
      last().drop(1011);
      const [wait] = clock.pendingDelays().filter((ms) => ms !== TERMINAL_HEALTHY_AFTER_MS);
      waits.push(wait!);
      clock.advance(wait!);
    }
    expect(waits).toStrictEqual([500, 1_000, 2_000]);
  });

  test("a connection that delivered data, or stayed up, starts the backoff over", () => {
    const { clock, connection, last } = setup();
    last().drop(1006); clock.advance(500);
    last().drop(1006); clock.advance(1_000);
    last().open();
    connection.markHealthy(last());
    last().drop(1006);
    expect(clock.pendingDelays()).toEqual([500]);

    clock.advance(500);
    last().open();
    clock.advance(TERMINAL_HEALTHY_AFTER_MS);
    last().drop(1006);
    expect(clock.pendingDelays()).toEqual([500]);
  });

  test("data still arriving from a replaced socket does not vouch for the new one", () => {
    const { clock, connection, last } = setup();
    const first = last();
    first.drop(1006); clock.advance(500);
    last().drop(1006); clock.advance(1_000);
    last().open();
    // Frames queued before the first socket closed are processed now.
    connection.markHealthy(first);
    last().drop(1006);
    expect(clock.pendingDelays().filter((ms) => ms !== TERMINAL_HEALTHY_AFTER_MS)).toEqual([2_000]);
  });

  test("a rejected request (1008) is an error and is not retried", () => {
    const { clock, sockets, statuses, last } = setup();
    last().drop(1008);
    clock.advance(60_000);
    expect(statuses.at(-1)).toBe("error");
    expect(sockets).toHaveLength(1);
  });

  test("reconnectNow skips a pending backoff, and does nothing while connected", () => {
    const { clock, sockets, connection, last } = setup();
    last().open();
    connection.reconnectNow();
    expect(sockets).toHaveLength(1);
    last().drop(1006); clock.advance(500);
    last().drop(1006);
    expect(clock.pendingDelays()).toEqual([1_000]);
    connection.reconnectNow();
    expect(sockets).toHaveLength(3);
    expect(clock.pendingDelays()).toEqual([]);
  });

  test("dispose closes the live socket normally and nothing reconnects after", () => {
    const { clock, sockets, statuses, connection, last } = setup();
    last().open();
    connection.dispose();
    expect(last().closedWith).toBe(1000);
    const before = statuses.length;
    last().drop(1000);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(statuses).toHaveLength(before);
  });

  test("dispose during a backoff cancels the pending reconnect", () => {
    const { clock, sockets, connection, last } = setup();
    last().drop(1006);
    connection.dispose();
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  test("events from a replaced socket are ignored", () => {
    const { clock, statuses, sockets, last } = setup();
    const first = last();
    first.drop(1006);
    clock.advance(500);
    last().open();
    const before = statuses.length;
    first.onopen?.({} as Event);
    first.onclose?.({ code: 1006 } as CloseEvent);
    expect(statuses).toHaveLength(before);
    expect(sockets).toHaveLength(2);
  });
});
