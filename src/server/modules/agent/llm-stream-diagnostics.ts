import { isLifecycleStreamPartType } from "../llm/first-output.js";

/** What one streamed LLM attempt did, for its Activity record and, with the
 *  stream trace on (config.json's logging.streamTrace, on by default), a
 *  part-by-part trace logged when the attempt fails. Time to first token is measured here: the first part
 *  carrying model output, not the SDK's local `start`. */

type LlmStreamStatus = "succeeded" | "failed";
const LLM_STREAM_TRACE_BUFFER_LIMIT = 200;

export interface LlmStreamDiagnosticsInput {
  startedAt: number;
  callId: string | null;
  wakeId: string;
  candidateIndex: number;
  attempt: number;
  provider?: string;
  model?: string;
  idleTimeoutMs: number;
}

export interface LlmStreamDiagnostics {
  recordPart: (part: { type: string }, timeoutActivity: boolean, visibleOutput: boolean) => void;
  summary: (status: LlmStreamStatus) => Record<string, unknown>;
  /** Time to first token, or null for a call the provider never answered.
   *  Also inside `summary()`, but that object is reduced away by retention
   *  while this rides in a column of its own. */
  ttftMs: () => number | null;
}

/** Exported for its own tests. The distinction it draws — the SDK's local
 *  `start` against the provider's first output — is the whole of what time to
 *  first token means, and it is not observable from outside the wake loop. */
export function createLlmStreamDiagnostics(input: LlmStreamDiagnosticsInput): LlmStreamDiagnostics {
  let partCount = 0;
  let modelDataPartCount = 0;
  let timeoutActivityPartCount = 0;
  let visibleOutputPartCount = 0;
  let textDeltaCount = 0;
  let toolCallCount = 0;
  let firstPartAtMs: number | null = null;
  // The first part carrying model output, which is not the first part: the SDK
  // emits `start` and `start-step` locally the moment the request goes out, so
  // `firstPartAtMs` measures our own dispatch — milliseconds, whatever the
  // provider's latency — and says nothing about the provider.
  let firstModelDataAtMs: number | null = null;
  let lastPartAtMs: number | null = null;
  let lastTimeoutActivityAtMs: number | null = null;
  let lastVisibleOutputAtMs: number | null = null;
  let lastPartType = "";
  const partTypes: Record<string, number> = {};
  const trace = traceOn;
  const traceEvents: Record<string, unknown>[] = [];
  let droppedTraceEvents = 0;

  return {
    ttftMs: () => firstModelDataAtMs,
    recordPart(part, timeoutActivity, visibleOutput) {
      const elapsedMs = Math.max(0, Date.now() - input.startedAt);
      partCount++;
      if (firstPartAtMs === null) firstPartAtMs = elapsedMs;
      lastPartAtMs = elapsedMs;
      lastPartType = part.type;
      partTypes[part.type] = (partTypes[part.type] ?? 0) + 1;
      if (!isLifecycleStreamPartType(part.type)) {
        modelDataPartCount++;
        if (firstModelDataAtMs === null) firstModelDataAtMs = elapsedMs;
      }
      if (timeoutActivity) {
        timeoutActivityPartCount++;
        lastTimeoutActivityAtMs = elapsedMs;
      }
      if (visibleOutput) {
        visibleOutputPartCount++;
        lastVisibleOutputAtMs = elapsedMs;
        if (part.type === "text-delta") textDeltaCount++;
        if (part.type === "tool-call") toolCallCount++;
      }
      if (trace) {
        bufferLlmStreamTrace(traceEvents, {
          event: "part",
          callId: input.callId,
          wakeId: input.wakeId,
          candidateIndex: input.candidateIndex,
          attempt: input.attempt,
          provider: input.provider,
          model: input.model,
          partType: part.type,
          elapsedMs,
          sinceLastTimeoutActivityMs: lastTimeoutActivityAtMs === null
            ? null
            : Math.max(0, elapsedMs - lastTimeoutActivityAtMs),
          sinceLastVisibleOutputMs: lastVisibleOutputAtMs === null
            ? null
            : Math.max(0, elapsedMs - lastVisibleOutputAtMs),
          timeoutActivity,
          partCount,
          modelDataPartCount,
          timeoutActivityPartCount,
          visibleOutputPartCount
        }, () => { droppedTraceEvents++; });
      }
    },
    summary(status) {
      const elapsedMs = Math.max(0, Date.now() - input.startedAt);
      const output = {
        status,
        partCount,
        modelDataPartCount,
        timeoutActivityPartCount,
        visibleOutputPartCount,
        textDeltaCount,
        toolCallCount,
        firstPartAtMs,
        firstModelDataAtMs,
        lastPartAtMs,
        lastTimeoutActivityAtMs,
        lastVisibleOutputAtMs,
        lastPartType: lastPartType || null,
        partTypes,
        elapsedMs,
        idleTimeoutMs: input.idleTimeoutMs
      };
      if (trace && status === "failed") {
        for (const event of traceEvents) logLlmStreamTrace(event);
        if (droppedTraceEvents > 0) {
          logLlmStreamTrace({
            event: "trace-truncated",
            callId: input.callId,
            wakeId: input.wakeId,
            candidateIndex: input.candidateIndex,
            attempt: input.attempt,
            provider: input.provider,
            model: input.model,
            retainedPartEvents: traceEvents.length,
            droppedPartEvents: droppedTraceEvents
          });
        }
        logLlmStreamTrace({
          event: "finish",
          callId: input.callId,
          wakeId: input.wakeId,
          candidateIndex: input.candidateIndex,
          attempt: input.attempt,
          provider: input.provider,
          model: input.model,
          ...output
        });
      }
      return output;
    }
  };
}

function bufferLlmStreamTrace(
  events: Record<string, unknown>[],
  event: Record<string, unknown>,
  onDrop: () => void
): void {
  if (events.length < LLM_STREAM_TRACE_BUFFER_LIMIT) {
    events.push(event);
    return;
  }
  onDrop();
}

let traceOn = true;

/** Set from config.json at start and on a reload; the model-call worker is
 *  told it in its logging message. */
export function setLlmStreamTrace(on: boolean): void {
  traceOn = on !== false;
}

export function llmStreamTrace(): boolean {
  return traceOn;
}

function logLlmStreamTrace(event: Record<string, unknown>): void {
  console.error(`[mandate] llm-stream: ${JSON.stringify(event)}`);
}
