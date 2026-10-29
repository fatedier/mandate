export interface MockWebSocket {
  readyState: number;
  sent: string[];
  send(data: string): void;
  close(code?: number, reason?: string): void;
  fireOpen(): void;
  fireClose(code: number, reason: string): void;
  fireError(err: Error): void;
  /** Simulate a real WS failure: onerror followed by onclose. */
  fireErrorAndClose(err: Error, code?: number): void;
  /** Deliver a JSON event "from upstream" */
  deliver(event: any): void;
  /** Resolves once `n` messages have been sent. */
  waitForSentMessages(n: number, timeoutMs?: number): Promise<void>;
  // The provider's own socket types (what a real WebSocket hands its
  // handlers), so the mock can be passed where a socket is expected.
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: { code?: number }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export function createMockWebSocket(): MockWebSocket {
  let onopen: (() => void) | null = null;
  let onmessage: ((e: { data: string }) => void) | null = null;
  let onclose: ((e: { code?: number }) => void) | null = null;
  let onerror: ((e: unknown) => void) | null = null;
  const sent: string[] = [];
  const waiters: Array<{ count: number; resolve: () => void; reject: (e: Error) => void; timer?: any }> = [];

  function checkWaiters() {
    for (const w of waiters.slice()) {
      if (sent.length >= w.count) {
        if (w.timer) clearTimeout(w.timer);
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  }

  return {
    readyState: 0,
    sent,
    send(data: string) {
      if (this.readyState !== 1) throw new Error("WebSocket not open");
      sent.push(data);
      checkWaiters();
    },
    close(_code, _reason) { this.readyState = 3; },
    fireOpen() { this.readyState = 1; onopen?.(); },
    // A real close event carries a reason too; the provider reads only the code.
    fireClose(code, reason) { this.readyState = 3; const event = { code, reason }; onclose?.(event); },
    fireError(err) { onerror?.({ error: err, message: err.message }); },
    fireErrorAndClose(err, code = 1006) {
      onerror?.({ error: err, message: err.message });
      this.readyState = 3;
      const event = { code, reason: err.message };
      onclose?.(event);
    },
    deliver(event) { onmessage?.({ data: JSON.stringify(event) }); },
    waitForSentMessages(n, timeoutMs = 1000) {
      if (sent.length >= n) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const w = { count: n, resolve, reject } as any;
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timeout waiting for ${n} sent messages (have ${sent.length})`));
        }, timeoutMs);
        waiters.push(w);
      });
    },
    get onopen() { return onopen; },
    set onopen(cb) { onopen = cb; },
    get onmessage() { return onmessage; },
    set onmessage(cb) { onmessage = cb; },
    get onclose() { return onclose; },
    set onclose(cb) { onclose = cb; },
    get onerror() { return onerror; },
    set onerror(cb) { onerror = cb; }
  };
}
