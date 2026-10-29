import type { HttpClient } from "../../platform/http/http-client.js";
import { untilAborted } from "./until-aborted.js";
import { statusLine } from "./http-status.js";

/** A page read that failed for a reason the agent is told as it is. */
export class PageError extends Error {}

export const PAGE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
/** Markdown first: a site that serves it saves the conversion. */
export const PAGE_ACCEPT = "text/markdown, text/html;q=0.9, */*;q=0.1";

const HTTP_ONLY = "web_fetch reads only http and https addresses.";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchedPage {
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
  /** Only the first MAX_PAGE_BYTES were read. */
  cut: boolean;
}

/**
 * One page, as the server reads it: redirects followed one at a time (at most
 * five, each address checked), the body read to 5 MB, all of it within one
 * timeout. A stop from `signal` rethrows its abort; everything else fails
 * as a PageError with its reason.
 */
export async function fetchPage(
  url: string,
  deps: { http: HttpClient; signal?: AbortSignal; timeoutMs?: number }
): Promise<FetchedPage> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), deps.timeoutMs ?? PAGE_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout.signal]) : timeout.signal;
  try {
    let current = httpUrl(url);
    for (let hops = 0; ; hops++) {
      const response = await deps.http.fetch(current, {
        redirect: "manual",
        headers: { accept: PAGE_ACCEPT },
        signal
      });
      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location) {
        void response.body?.cancel().catch(() => {});
        if (hops >= MAX_REDIRECTS) throw new PageError("The page redirected more than 5 times.");
        current = httpUrl(location, current);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const status = statusLine(response.status);
        throw new PageError(`The page answered ${status}.`);
      }
      const { body, cut } = await readBody(response, signal);
      return { finalUrl: current, contentType: response.headers.get("content-type") ?? "", body, cut };
    }
  } catch (error) {
    if (deps.signal?.aborted) throw deps.signal.reason;
    if (timeout.signal.aborted) throw new PageError("The page did not answer within 30 s.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function httpUrl(value: string, base?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    throw new PageError(HTTP_ONLY);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new PageError(HTTP_ONLY);
  return parsed.href;
}

async function readBody(response: Response, signal: AbortSignal): Promise<{ body: Uint8Array; cut: boolean }> {
  if (!response.body) return { body: new Uint8Array(), cut: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await untilAborted(reader.read(), signal);
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    }
    const { done, value } = next;
    if (done) break;
    // Only what fits under the limit is kept, however large a chunk comes.
    const room = MAX_PAGE_BYTES - size;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    size += value.byteLength;
    if (size >= MAX_PAGE_BYTES) {
      // A body that fills the limit exactly is whole only if nothing follows;
      // one that breaks right there keeps what came. A stop or the timeout
      // is still that.
      cut = size > MAX_PAGE_BYTES || (await untilAborted(reader.read(), signal).then((next) => !next.done, (error: unknown) => {
        if (signal.aborted) throw error;
        return true;
      }));
      void reader.cancel().catch(() => {});
      break;
    }
  }
  const all = new Uint8Array(Math.min(size, MAX_PAGE_BYTES));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return { body: all, cut };
}
