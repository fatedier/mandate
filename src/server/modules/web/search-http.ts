import { errorText } from "../../../shared/error-text.js";
import { NO_ANSWER_IN_TIME, SearchFailure, type SearchCallContext } from "./search-kind.js";
import { untilAborted } from "./until-aborted.js";
import { statusLine } from "./http-status.js";

const SERVICE_MESSAGE_MAX = 200;
const RETRY_AFTER_MS = 1000;

type Attempt = { ok: true; value: unknown } | { ok: false; error: Error; retry: boolean };

/**
 * One JSON request to a search service. A network error, a 5xx or a 429 is
 * sent once more after a pause; a timeout or another 4xx is not. A failure
 * reads as the status and the service's own message; a stop rethrows its
 * abort.
 */
export async function requestJson(url: string, init: RequestInit, ctx: SearchCallContext): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const outcome = await once(url, init, ctx);
    if (outcome.ok) return outcome.value;
    if (outcome.retry && attempt === 1) {
      await untilAborted(ctx.wait(RETRY_AFTER_MS), ctx.signal);
      continue;
    }
    throw outcome.error;
  }
}

async function once(url: string, init: RequestInit, ctx: SearchCallContext): Promise<Attempt> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ctx.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);
  let response: Response | null = null;
  try {
    response = await ctx.http.fetch(url, { ...init, signal });
    if (!response.ok) {
      const message = await serviceMessage(response, signal);
      const status = statusLine(response.status);
      return {
        ok: false,
        error: new SearchFailure(message ? `${status}: ${message}` : status, response.status),
        retry: response.status >= 500 || response.status === 429
      };
    }
    return { ok: true, value: JSON.parse(await untilAborted(response.text(), signal)) };
  } catch (error) {
    if (signal.aborted) void response?.body?.cancel().catch(() => {});
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (timeout.signal.aborted) return { ok: false, error: new SearchFailure(NO_ANSWER_IN_TIME), retry: false };
    if (error instanceof SyntaxError) return { ok: false, error: new SearchFailure(errorText(error)), retry: false };
    return { ok: false, error: new SearchFailure(errorText(error)), retry: true };
  } finally {
    clearTimeout(timer);
  }
}

/** What a service said about its refusal, from the usual JSON shapes. */
async function serviceMessage(response: Response, signal: AbortSignal): Promise<string> {
  // A stop or a timeout while the body is read is that, not the refusal; a
  // body that breaks leaves the status alone.
  let raw: string;
  try {
    raw = await untilAborted(response.text(), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return "";
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "";
  }
  const pick = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return pick(record.error) || pick(record.message);
    }
    return "";
  };
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = (pick(record.detail) || pick(record.error) || pick(record.message)).replace(/\s+/g, " ").trim();
  return message.slice(0, SERVICE_MESSAGE_MAX);
}
