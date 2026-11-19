/**
 * The model-call worker: runs a wake step's model stream (model-stream.ts)
 * off the server's main thread, which sends it what to stream and hears back
 * what the stream would have told it there. Models are built here from the
 * candidate's plain config, tools from the schema catalog; nothing here reads
 * or writes Mandate's state. See model-call-host.ts for the other side.
 */
import "./model-call-worker-errors.js";
import type { LanguageModel, ToolSet } from "ai";
import { createStallWatch } from "../../platform/diagnostics/stall-watch.js";
import { setLogLevel, setLogStacks } from "../../platform/logger.js";
import { setLlmStreamTrace } from "./llm-stream-diagnostics.js";
import { decodeData, decodeError, decodePrompt, encodeData, encodeError } from "./model-call-codec.js";
import type { FromWorker, ToWorker } from "./model-call-protocol.js";
import { createAgentProvider, snapshotKey, type AgentProviderSnapshot } from "./llm-provider.js";
import { openAttemptStreamState, streamModelOnce, type AttemptStreamState, type ModelStreamInput } from "./model-stream.js";
import { TOOL_INPUT_SCHEMAS } from "./tool-schema-catalog.js";
import { buildToolSet, type OfferedToolSpec } from "./tool-set.js";

declare const self: Worker;

const MODEL_CACHE = 16;
const TOOL_SET_CACHE = 32;
const ALIVE_EVERY_MS = 1_000;

const post = (message: FromWorker) => self.postMessage(message);

const models = new Map<string, LanguageModel>();
const toolSets = new Map<string, ToolSet>();
const attempts = new Map<string, { state: AttemptStreamState; abort: AbortController }>();
/** Each running stream's attempt, for an abort. */
const streams = new Map<string, string>();

function remembered<T>(cache: Map<string, T>, key: string, limit: number, make: () => T): T {
  const held = cache.get(key);
  if (held !== undefined) {
    cache.delete(key);
    cache.set(key, held);
    return held;
  }
  const made = make();
  cache.set(key, made);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
  return made;
}

const modelFor = (snapshot: AgentProviderSnapshot) =>
  remembered(models, snapshotKey(snapshot), MODEL_CACHE, () => createAgentProvider(snapshot).model);

// An empty list is an empty set, as the step hands this thread's stream.
const toolsFor = (specs: OfferedToolSpec[]): ToolSet =>
  remembered(toolSets, JSON.stringify(specs), TOOL_SET_CACHE, () => buildToolSet(specs, TOOL_INPUT_SCHEMAS));

async function stream(message: Extract<ToWorker, { type: "stream" }>): Promise<void> {
  const { streamId } = message;
  try {
    const model = modelFor(message.snapshot);
    let attempt = attempts.get(message.attemptId);
    if (!attempt) {
      const abort = new AbortController();
      attempt = {
        abort,
        state: openAttemptStreamState({ model, timeout: message.timeout, idleMs: message.idleMs, parentSignal: abort.signal, diagnostics: message.diagnostics })
      };
      attempts.set(message.attemptId, attempt);
    }
    streams.set(streamId, message.attemptId);
    const input: ModelStreamInput = {
      model,
      tools: toolsFor(message.tools),
      ...(message.system !== undefined ? { system: message.system } : {}),
      messages: decodePrompt(message.messages),
      callOptions: decodeData<ModelStreamInput["callOptions"]>(message.callOptions),
      askSummary: message.askSummary
    };
    const output = await streamModelOnce(input, attempt.state, {
      onReasoning: () => post({ type: "reasoning", streamId }),
      onHeading: (heading) => post({ type: "heading", streamId, heading }),
      onTextDelta: (text) => post({ type: "delta", streamId, text }),
      onSummaryInBody: (sent) => post({ type: "summary", streamId, sent })
    });
    post({ type: "done", streamId, output: encodeData(output) });
  } catch (error) {
    post({ type: "failed", streamId, error: encodeError(error) });
  } finally {
    streams.delete(streamId);
  }
}

function endAttempt(message: Extract<ToWorker, { type: "endAttempt" }>): void {
  const attempt = attempts.get(message.attemptId);
  if (!attempt) {
    post({ type: "attemptEnded", attemptId: message.attemptId, diagnostics: null });
    return;
  }
  attempts.delete(message.attemptId);
  attempt.state.idle.cleanup();
  post({
    type: "attemptEnded",
    attemptId: message.attemptId,
    diagnostics: { summary: attempt.state.diagnostics.summary(message.status), ttftMs: attempt.state.diagnostics.ttftMs() }
  });
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "stream") void stream(message);
  else if (message.type === "abort") {
    const attemptId = streams.get(message.streamId);
    if (attemptId) attempts.get(attemptId)?.abort.abort(decodeError(message.reason));
  } else if (message.type === "endAttempt") endAttempt(message);
  else if (message.type === "logging") {
    setLogLevel(message.level);
    setLogStacks(message.stacks);
    setLlmStreamTrace(message.streamTrace);
  }
};

// Its own stall watch: a block here is not the main thread's.
createStallWatch({ log: (line) => { console.log(line.replace(/^\[mandate\]/, "[mandate model worker]")); } }).start();
setInterval(() => post({ type: "alive" }), ALIVE_EVERY_MS);
post({ type: "ready" });
