/**
 * The model-call worker as it is, for tests that need to see into it or
 * slow it down:
 *  - after each message it handles, it reports the log level, stacks and
 *    stream trace settings it now uses ({ type: "probeLevel", level, stacks, trace });
 *  - MODEL_WORKER_PROBE_END_DELAY_MS in its env holds back each answer to an
 *    attempt's end by that long.
 */
import { getLogLevel, logStacks } from "../../src/server/platform/logger.js";
import { llmStreamTrace } from "../../src/server/modules/agent/llm-stream-diagnostics.js";
import "../../src/server/modules/agent/model-call-worker.js";

declare const self: Worker;

export {};

const endDelayMs = Number(process.env.MODEL_WORKER_PROBE_END_DELAY_MS ?? 0);
const post = self.postMessage.bind(self);
self.postMessage = ((message: { type?: string }) => {
  if (endDelayMs > 0 && message?.type === "attemptEnded") setTimeout(() => post(message), endDelayMs);
  else post(message);
}) as typeof self.postMessage;

const handle = self.onmessage!;
self.onmessage = (event: MessageEvent) => {
  handle.call(self, event);
  self.postMessage({ type: "probeLevel", level: getLogLevel(), stacks: logStacks(), trace: llmStreamTrace() });
};
