import { onCleanup } from "./cleanup.js";

/**
 * A stand-in for fetch, behaving as a network does where a test can tell:
 * - the request goes out at the call: the handler runs then, so a test can
 *   count requests or take hold of a resolver right after starting one;
 * - a request whose signal is aborted, before or while it is being answered,
 *   rejects with the signal's reason (an AbortError unless abort() was given
 *   one); one aborted before the call never reaches the handler;
 * - the answer settles on a later microtask, never within the call, so an
 *   abort that comes after the call still wins. A mock already settled when
 *   abort fires lets an abandoned response reach setState, which no real
 *   request can, and hides every "cleanup ran, then setup ran again" bug.
 * The real (network-refusing) fetch from tests/setup.ts is put back after
 * the test.
 */
export interface FetchCall {
  url: string;
  /** Upper-case, GET when none was given. */
  method: string;
  init?: RequestInit;
}

export type FetchHandler = (call: FetchCall, index: number) => Response | Promise<Response>;

interface FetchOptions {
  /** Deliver the handler's answer even when the request's signal aborts
   *  after the call: for a test of the race a real network allows, where the
   *  response has landed as the abort comes and the code must drop it
   *  itself. A request aborted before the call is still refused. */
  ignoreAbort?: boolean;
}

/** Replaces fetch for the rest of the test; returns every call, in order,
 *  refused ones included. */
export function mockFetch(handler: FetchHandler, options: FetchOptions = {}): FetchCall[] {
  const original = globalThis.fetch;
  onCleanup(() => { globalThis.fetch = original; });
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = typeof input === "object" && !(input instanceof URL) ? input : undefined;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const call: FetchCall = { url, method, init };
    const index = calls.length;
    calls.push(call);
    // An explicit `signal: null` disconnects the Request's own, as fetch does.
    const signal = init !== undefined && "signal" in init ? init.signal : request?.signal;
    return new Promise<Response>((resolve, reject) => {
      // The signal's own reason: an AbortError unless abort() was given one.
      const abort = () => reject(signal!.reason);
      if (signal?.aborted) {
        abort();
        return;
      }
      // ignoreAbort lets only an abort after the call go unheard.
      if (!options.ignoreAbort) signal?.addEventListener("abort", abort, { once: true });
      let answer: Promise<Response>;
      try {
        answer = Promise.resolve(handler(call, index));
      } catch (error) {
        answer = Promise.reject(error);
      }
      // A promise reaction: it settles on a later microtask, never in the call.
      void answer.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    });
  }) as typeof fetch;
  return calls;
}

/** mockFetch for the length of `run` only; `run` gets the calls. */
export async function withFetch(
  handler: FetchHandler,
  run: (calls: FetchCall[]) => void | Promise<void>,
  options: FetchOptions = {}
): Promise<void> {
  const original = globalThis.fetch;
  try {
    await run(mockFetch(handler, options));
  } finally {
    globalThis.fetch = original;
  }
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
