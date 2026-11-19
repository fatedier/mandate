import type { SystemModelMessage, TimeoutConfiguration, ToolSet } from "ai";
import type { LogLevel } from "../../platform/logger.js";
import type { AgentProviderSnapshot } from "./llm-provider.js";
import type { LlmStreamDiagnosticsInput } from "./llm-stream-diagnostics.js";
import type { OfferedToolSpec } from "./tool-registry.js";

/** The messages between the main thread and the model-call worker. One
 *  ordered channel (the Worker's port). Values that structured clone would
 *  change (errors, URLs) go through model-call-codec.ts. */

/** What finishCall reads of an attempt's stream diagnostics. */
export interface HostDiagnostics {
  summary: Record<string, unknown>;
  ttftMs: number | null;
}

export type ToWorker =
  | {
      type: "stream";
      streamId: string;
      attemptId: string;
      threadId: string;
      wakeId: string;
      snapshot: AgentProviderSnapshot;
      tools: OfferedToolSpec[];
      system?: string | SystemModelMessage | SystemModelMessage[];
      /** encodePrompt(ModelMessage[]). */
      messages: unknown;
      /** encodePrompt of candidateCallOptions without the model. */
      callOptions: unknown;
      askSummary: boolean;
      timeout: TimeoutConfiguration<ToolSet>;
      idleMs: number;
      diagnostics: LlmStreamDiagnosticsInput;
    }
  | { type: "abort"; streamId: string; /** encodeError(reason). */ reason: unknown }
  /** The attempt is over on the main thread: the worker takes its stream
   *  diagnostics' summary under this status (a failed one logs the trace, as
   *  on the main thread), answers with it, and drops what it kept for the
   *  attempt. */
  | { type: "endAttempt"; attemptId: string; status: "succeeded" | "failed" }
  /** The main thread's log level, stacks and stream trace settings: the
   *  worker's first message, and again before a stream when one changed (a
   *  config reload). */
  | { type: "logging"; level: LogLevel; stacks: boolean; streamTrace: boolean };

export type FromWorker =
  | { type: "ready" }
  | { type: "alive" }
  | { type: "reasoning"; streamId: string }
  | { type: "summary"; streamId: string; sent: boolean | null }
  | { type: "delta"; streamId: string; text: string }
  | { type: "heading"; streamId: string; heading: string }
  | { type: "done"; streamId: string; /** encodePrompt(ModelStreamOutput). */ output: unknown }
  | { type: "failed"; streamId: string; /** encodeError(error). */ error: unknown }
  /** Null for an attempt it never streamed. */
  | { type: "attemptEnded"; attemptId: string; diagnostics: HostDiagnostics | null };
