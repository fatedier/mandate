/**
 * Time to first token: from the request to the first part the provider
 * sent. The SDK emits `start` and `start-step` locally the moment the
 * request goes out, and `finish-step`, `finish`, `abort` and `error` close
 * a stream; none of them is the provider answering, so none counts.
 */
export function isLifecycleStreamPartType(type: string): boolean {
  switch (type) {
    case "start":
    case "start-step":
    case "finish-step":
    case "finish":
    case "abort":
    case "error":
      return true;
    default:
      return false;
  }
}

export interface FirstOutputClock {
  /** A part of the stream, by its type, as it arrives. */
  note(type: string): void;
  /** Milliseconds from the clock's start to the first output, or null
   *  while (or when) there was none. */
  ms(): number | null;
}

/** Whether a part is the provider answering. A raw provider frame (with
 *  `includeRawChunks`) is not of itself: it can be one that carries no
 *  output (`response.created`); the parts the SDK reads out of it are. */
function countsAsOutput(type: string): boolean {
  return type !== "raw" && !isLifecycleStreamPartType(type);
}

/** Started at its making: make it as the request goes out. */
export function firstOutputClock(now: () => number = Date.now): FirstOutputClock {
  const startedAt = now();
  let first: number | null = null;
  return {
    note(type) {
      if (first === null && countsAsOutput(type)) first = Math.max(0, now() - startedAt);
    },
    ms: () => first
  };
}

/** The first output a call's result or error carries (`firstOutputMs`), for
 *  its record; null when it carries none. */
export function firstOutputOf(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const ms = (value as { firstOutputMs?: unknown }).firstOutputMs;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
}

/** Best effort: what an error saw of the stream, carried with it to the
 *  call's record. A frozen error is left as it is. */
export function carryFirstOutput(error: unknown, ms: number | null): void {
  if (!error || typeof error !== "object") return;
  try {
    (error as { firstOutputMs?: number | null }).firstOutputMs = ms;
  } catch {
    /* the error matters more than the reading */
  }
}
