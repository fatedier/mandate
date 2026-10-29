import type { LanguageModel, TimeoutConfiguration, ToolSet } from "ai";
import { isRecord } from "../../../shared/guards.js";
import { stepTimeoutFor } from "./timeouts.js";

interface FirstChunkTimeoutGuard {
  signal: AbortSignal;
  markChunk: () => void;
  cleanup: () => void;
}

interface StreamIdleTimeoutGuard {
  signal: AbortSignal;
  markActivity: () => void;
  cleanup: () => void;
}

/** A provider chunk that carries output on: a streamed delta event
 *  (`response.function_call_arguments.delta`, `response.output_text.delta`,
 *  ...). A heartbeat (`ping`) and the frames around them carry nothing. */
export function isProviderProgressChunk(raw: unknown): boolean {
  return isRecord(raw) && typeof raw.type === "string" && raw.type.endsWith(".delta");
}

/** Whether a stream part shows the call is alive: any part but the ones that
 *  end a stream, and of the provider's raw chunks only a delta. */
export function isIdleActivityChunk(chunk: { type: string; rawValue?: unknown }): boolean {
  if (chunk.type === "raw") return isProviderProgressChunk(chunk.rawValue);
  return chunk.type !== "abort" && chunk.type !== "error" && chunk.type !== "finish";
}

/**
 * The one way every model call is cut when its stream goes quiet (an agent's
 * step, a dream step, memory extraction, a compaction's summary): the options
 * to spread into streamText, and the cleanup to call once the call is over.
 * Every part the SDK hands onChunk (isIdleActivityChunk) starts the window
 * over; the SDK's own chunk timer goes with it, except on the Open Responses
 * package, which sends nothing while a tool call's arguments stream
 * (stepTimeoutFor).
 */
export function idleGuardedStreamOptions(input: {
  model: LanguageModel;
  timeout: TimeoutConfiguration<ToolSet>;
  idleMs: number;
  /** The caller's own abort, which the guard follows. */
  parentSignal?: AbortSignal | undefined;
  /** The caller's own onChunk, still called for every part. */
  onChunk?: ((event: { chunk: { type: string; rawValue?: unknown } }) => unknown) | undefined;
}) {
  const guard = createStreamIdleTimeoutGuard(input.parentSignal, input.idleMs);
  return {
    options: {
      abortSignal: guard.signal,
      includeRawChunks: true as const,
      timeout: stepTimeoutFor(input.model, input.timeout),
      onChunk: (event: { chunk: { type: string; rawValue?: unknown } }) => {
        if (isIdleActivityChunk(event.chunk)) guard.markActivity();
        return input.onChunk?.(event) as void;
      }
    },
    cleanup: guard.cleanup
  };
}

/** Aborts after the first chunk is late; the first chunk stops the clock for good. */
export function createFirstChunkTimeoutGuard(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): FirstChunkTimeoutGuard {
  const guard = createTimeoutGuard(parentSignal, timeoutMs, () => new DOMException(
    `LLM stream did not produce a first chunk within ${timeoutMs}ms.`,
    "TimeoutError"
  ));
  return { signal: guard.signal, markChunk: guard.stop, cleanup: guard.cleanup };
}

/** Aborts after the stream goes quiet; every activity starts the clock over. */
export function createStreamIdleTimeoutGuard(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): StreamIdleTimeoutGuard {
  const guard = createTimeoutGuard(parentSignal, timeoutMs, () => new DOMException(
    `LLM stream timed out waiting for activity after ${timeoutMs}ms.`,
    "TimeoutError"
  ));
  return { signal: guard.signal, markActivity: guard.restart, cleanup: guard.cleanup };
}

// One clock on an AbortController that also follows the parent's abort. The
// clock starts at once unless the parent has already aborted.
function createTimeoutGuard(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutError: () => DOMException
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  // Cleaned up, or already aborted: a part that comes after starts nothing.
  let ended = false;

  const stop = () => {
    if (timeout === null) return;
    clearTimeout(timeout);
    timeout = null;
  };

  const restart = () => {
    stop();
    if (ended || controller.signal.aborted) return;
    timeout = setTimeout(() => {
      timeout = null;
      controller.abort(timeoutError());
    }, timeoutMs);
  };

  const abortFromParent = () => {
    stop();
    controller.abort(parentSignal?.reason ?? new DOMException("Operation aborted.", "AbortError"));
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    restart();
  }

  return {
    signal: controller.signal,
    restart,
    stop,
    cleanup: () => {
      ended = true;
      stop();
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}
