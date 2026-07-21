export interface FirstChunkTimeoutGuard {
  signal: AbortSignal;
  markChunk: () => void;
  cleanup: () => void;
}

export interface StreamIdleTimeoutGuard {
  signal: AbortSignal;
  markActivity: () => void;
  cleanup: () => void;
}

export function createFirstChunkTimeoutGuard(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): FirstChunkTimeoutGuard {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(firstChunkTimeoutError(timeoutMs));
  }, timeoutMs);

  const clear = () => {
    if (timeout === null) return;
    clearTimeout(timeout);
    timeout = null;
  };

  const abortFromParent = () => {
    clear();
    controller.abort(parentSignal?.reason ?? new DOMException("Operation aborted.", "AbortError"));
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    markChunk: clear,
    cleanup: () => {
      clear();
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

function firstChunkTimeoutError(timeoutMs: number): DOMException {
  return new DOMException(
    `LLM stream did not produce a first chunk within ${timeoutMs}ms.`,
    "TimeoutError"
  );
}

export function createStreamIdleTimeoutGuard(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): StreamIdleTimeoutGuard {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const abortForIdle = () => {
    timeout = null;
    controller.abort(streamIdleTimeoutError(timeoutMs));
  };

  const reset = () => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(abortForIdle, timeoutMs);
  };

  const clear = () => {
    if (timeout === null) return;
    clearTimeout(timeout);
    timeout = null;
  };

  const abortFromParent = () => {
    clear();
    controller.abort(parentSignal?.reason ?? new DOMException("Operation aborted.", "AbortError"));
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    reset();
  }

  return {
    signal: controller.signal,
    markActivity: reset,
    cleanup: () => {
      clear();
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

function streamIdleTimeoutError(timeoutMs: number): DOMException {
  return new DOMException(
    `LLM stream timed out waiting for activity after ${timeoutMs}ms.`,
    "TimeoutError"
  );
}
