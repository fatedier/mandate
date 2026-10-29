/**
 * Keeps a terminal WebSocket connected: when the socket closes for any reason
 * other than being disposed or rejected outright, it opens a new one after a
 * backoff, and keeps doing so for as long as the terminal is mounted.
 *
 * Only the connection policy lives here. The caller's `open` creates the
 * socket and wires its message handling; this module owns `onopen`,
 * `onclose` and `onerror`.
 */

export type TerminalConnectionStatus = "connecting" | "connected" | "reconnecting" | "error";

/** Waits before each reconnect, by consecutive failures; the last repeats. */
export const TERMINAL_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;

/** A connection this old counts as healthy even if nothing has arrived yet,
 *  so its eventual drop starts the backoff from the beginning again. */
export const TERMINAL_HEALTHY_AFTER_MS = 5_000;

/** The server closes with 1008 when the request itself is wrong (no pane id,
 *  unknown project): asking again gets the same answer. */
const REJECTED_CLOSE_CODE = 1008;

function terminalReconnectDelayMs(failures: number): number {
  const index = Math.min(Math.max(failures, 1), TERMINAL_RECONNECT_DELAYS_MS.length) - 1;
  return TERMINAL_RECONNECT_DELAYS_MS[index]!;
}

/** The part of WebSocket this module touches. */
export interface TerminalSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(code?: number, reason?: string): void;
}

interface Timers {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

const CONNECTING = 0;
const OPEN = 1;

export interface TerminalConnection {
  /** `socket` delivered data, so it is healthy and its next drop retries
   *  fast. Ignored unless `socket` is the live one: frames still queued from
   *  a closed socket must not vouch for its replacement. */
  markHealthy(socket: TerminalSocket): void;
  /** Skip the rest of a pending backoff (the backend is known to be back). */
  reconnectNow(): void;
  /** Stop for good and close the current socket. */
  dispose(): void;
}

export function connectTerminal(options: {
  /** Creates attempt `attempt`'s socket (0 is the first connection). */
  open: (attempt: number) => TerminalSocket;
  onOpen?: (socket: TerminalSocket, attempt: number) => void;
  onStatus: (status: TerminalConnectionStatus) => void;
  timers?: Timers;
}): TerminalConnection {
  const timers = options.timers ?? defaultTimers;
  let attempt = 0;
  let failures = 0;
  let disposed = false;
  let socket: TerminalSocket | null = null;
  let retryTimer: unknown = null;
  let healthyTimer: unknown = null;

  const clearHealthyTimer = () => {
    if (healthyTimer !== null) timers.clear(healthyTimer);
    healthyTimer = null;
  };

  const markHealthy = () => {
    clearHealthyTimer();
    failures = 0;
  };

  const connect = () => {
    retryTimer = null;
    const current = options.open(attempt);
    const currentAttempt = attempt;
    socket = current;
    current.onopen = () => {
      if (disposed || socket !== current) return;
      options.onStatus("connected");
      clearHealthyTimer();
      healthyTimer = timers.set(markHealthy, TERMINAL_HEALTHY_AFTER_MS);
      options.onOpen?.(current, currentAttempt);
    };
    // An error is always followed by a close; the close decides.
    current.onerror = () => {};
    current.onclose = (event) => {
      if (disposed || socket !== current) return;
      clearHealthyTimer();
      socket = null;
      if (event.code === REJECTED_CLOSE_CODE) {
        options.onStatus("error");
        return;
      }
      failures += 1;
      attempt += 1;
      options.onStatus("reconnecting");
      retryTimer = timers.set(connect, terminalReconnectDelayMs(failures));
    };
  };

  options.onStatus("connecting");
  connect();

  return {
    markHealthy(from) {
      if (!disposed && from === socket) markHealthy();
    },
    reconnectNow() {
      if (disposed || retryTimer === null) return;
      timers.clear(retryTimer);
      connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retryTimer !== null) timers.clear(retryTimer);
      retryTimer = null;
      clearHealthyTimer();
      const current = socket;
      socket = null;
      if (current && (current.readyState === OPEN || current.readyState === CONNECTING)) {
        current.close(1000);
      }
    }
  };
}
