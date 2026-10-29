import { z } from "zod";
import type { ToolDefinition } from "../agent/tool-registry.js";
import { languageToIsoCode } from "./voice-provider.js";
import type {
  VoiceProvider, VoiceProviderConfig, VoiceSession,
  VoiceSessionEvents, VoiceAudioFrame, VoiceProviderError, VoiceResponseMetadata
} from "./voice-provider.js";
import { isRecord } from "../../../shared/guards.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "../../../shared/base64.js";

const DEFAULT_OPENAI_URL = "wss://api.openai.com/v1/realtime";

interface RealtimeFunctionSchema {
  type: "function";
  name: string;
  description: string;
  parameters: unknown; // JSON Schema object
}

/** Translate a Mandate ToolDefinition into the OpenAI Realtime function
 *  schema format. Uses zod's built-in JSON-schema emit (z.toJSONSchema). */
export function toRealtimeFunctionSchema(def: ToolDefinition): RealtimeFunctionSchema {
  return {
    type: "function",
    name: def.name,
    description: def.description,
    parameters: z.toJSONSchema(def.parameters)
  };
}

export interface OpenAIRealtimeProviderDeps {
  /** Optional injection hook for tests. Defaults to native WebSocket. */
  wsFactory?: (url: string, headers: Record<string, string>) => RealtimeWebSocket;
  /** How long an opening may wait for session.updated before it is given
   *  up (and its socket closed). Default 15 000. */
  handshakeTimeoutMs?: number;
  /** Optional auth hook for provider variants that use the same OpenAI
   *  Realtime protocol but different credentials. */
  resolveAuthHeaders?: (
    config: VoiceProviderConfig,
    context: { baseURL: string; isAzure: boolean }
  ) => Promise<Record<string, string>> | Record<string, string>;
  /** Override default `wss://api.openai.com/v1/realtime`. For Azure OpenAI
   *  GA: `wss://<resource>.openai.azure.com/openai/v1/realtime`. The
   *  provider detects Azure by host and switches to api-key auth + the
   *  deployment-name query parameter automatically. */
  baseURL?: string;
  /** Azure-only: deployment name. Falls back to `config.model` when unset
   *  (typical for "model name = deployment name" deployments). */
  deployment?: string;
}

interface RealtimeWebSocket {
  onopen: (() => void) | null;
  onmessage: ((msg: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class OpenAIRealtimeProvider implements VoiceProvider {
  constructor(private deps: OpenAIRealtimeProviderDeps = {}) {}

  async startSession(config: VoiceProviderConfig, events: VoiceSessionEvents, signal?: AbortSignal): Promise<VoiceSession> {
    // Cancelled before it began: not even credentials are asked for.
    if (signal?.aborted) throw new Error("network: cancelled");
    const baseURL = this.deps.baseURL ?? DEFAULT_OPENAI_URL;
    const isAzure = baseURL.includes(".azure.com");
    let url: string;
    if (isAzure) {
      // Azure GA: baseURL must point at `/openai/v1/realtime`.
      const deployment = this.deps.deployment ?? config.model;
      url = `${baseURL}?model=${encodeURIComponent(deployment)}`;
    } else {
      url = `${baseURL}?model=${encodeURIComponent(config.model)}`;
    }
    // Credentials may take a while (a token refresh): a cancel meanwhile
    // ends the opening at once, and no socket is made for it.
    const headers = this.deps.resolveAuthHeaders
      ? await untilAborted(Promise.resolve(this.deps.resolveAuthHeaders(config, { baseURL, isAzure })), signal)
      : defaultAuthHeaders(config, isAzure);
    // A cancel can land after they resolve and before this resumes.
    if (signal?.aborted) throw new Error("network: cancelled");
    const ws: RealtimeWebSocket = this.deps.wsFactory
      ? this.deps.wsFactory(url, headers)
      : createNativeWebSocket(url, headers);

    return new Promise((resolve, reject) => {
      let handshakeFinished = false;
      // An opening that fails, times out or is cancelled closes its socket
      // and hears nothing more from it: nothing of it outlives the attempt.
      const settle = () => {
        handshakeFinished = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: VoiceProviderError) => {
        if (handshakeFinished) {
          events.onError(err);
          return;
        }
        settle();
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(1000, "opening failed"); } catch { /* ignore */ }
        reject(new Error(`${err.kind}: ${err.message}`));
      };
      const onAbort = () => fail({ kind: "network", message: "cancelled" });
      const deadline = setTimeout(
        () => fail({ kind: "network", message: "the voice service did not answer in time" }),
        this.deps.handshakeTimeoutMs ?? 15_000
      );
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort);

      ws.onopen = () => {
        // GA schema (gpt-realtime, 2025-08-28+): `session.type` is required,
        // and audio config is nested under `audio.{input,output}`.
        const transcription: { model: string; language?: string } = { model: "gpt-4o-transcribe" };
        const languageCode = languageToIsoCode(config.language);
        if (languageCode) transcription.language = languageCode;
        const sessionUpdate = {
          type: "session.update",
          session: {
            type: "realtime",
            model: config.model,
            instructions: config.systemPrompt,
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription,
                turn_detection: { type: "server_vad" }
              },
              output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice: config.voice
              }
            },
            tools: config.tools.map(toRealtimeFunctionSchema),
            tool_choice: "auto"
          }
        };
        ws.send(JSON.stringify(sessionUpdate));
      };

      ws.onmessage = (msg: { data: string }) => {
        let event: unknown;
        try { event = JSON.parse(msg.data); } catch { return; }
        if (!isRecord(event) || typeof event.type !== "string") return;
        if (event.type === "session.updated" && !handshakeFinished) {
          settle();
          resolve(buildSession(ws, events, config.voice));
          return;
        }
        if (event.type === "error") {
          const error = isRecord(event.error) ? event.error : {};
          const code = typeof error.code === "string" ? error.code : "";
          const message = typeof error.message === "string" ? error.message : "unknown error";
          if (code === "invalid_request_error" || message.includes("Incorrect API key")) {
            fail({ kind: "auth", message });
          } else if (code === "rate_limit_exceeded") {
            fail({ kind: "rate-limit", message });
          } else {
            fail({ kind: "protocol", message });
          }
          return;
        }
      };

      ws.onerror = (e: unknown) => {
        const message = isRecord(e) && typeof e.message === "string" ? e.message : String(e);
        fail({ kind: "network", message });
      };

      ws.onclose = (e: unknown) => {
        if (!handshakeFinished) {
          const code = isRecord(e) ? e.code : undefined;
          fail({ kind: "network", message: `connection closed before ready (${code ?? ""})` });
          return;
        }
        events.onClose();
      };
    });
  }
}

/** `work`, unless `signal` aborts first (the work itself goes on, unheard).
 *  The caller has checked that it had not aborted yet. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("network: cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener("abort", onAbort); reject(err); }
    );
  });
}

function defaultAuthHeaders(config: VoiceProviderConfig, isAzure: boolean): Record<string, string> {
  if (isAzure) {
    return { "api-key": config.apiKey };
  }
  return { Authorization: `Bearer ${config.apiKey}` };
}

function buildSession(ws: RealtimeWebSocket, events: VoiceSessionEvents, _voice: string): VoiceSession {
  // Our response.create events carry an id: an error event names the client
  // event that caused it, so any refusal of ours is known as one.
  const ours = { next: 0, last: null as string | null };
  ws.onmessage = (msg: { data: string }) => handleEvent(msg.data, ws, events, ours);
  // Session-level audio.output.voice is sticky once set. _voice is kept in
  // the signature for future provider variants that support per-response
  // overrides.
  return {
    sendAudio(frame: VoiceAudioFrame) {
      const b64 = arrayBufferToBase64(frame.pcm);
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    },
    sendToolResult(callId, payload) {
      const output = payload.errorMessage !== undefined
        ? JSON.stringify({ error: payload.errorMessage })
        : JSON.stringify(payload.result ?? null);
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output }
      }));
    },
    sendContextMessage(text: string) {
      ws.send(JSON.stringify(buildMessageItem("user", text)));
    },
    requestResponse(options?: { metadata?: VoiceResponseMetadata; toolChoice?: "none" }) {
      // A tagged response.create carries response.metadata, which the server
      // echoes on that response's events; tool_choice holds for it alone.
      const response = {
        ...(options?.metadata ? { metadata: options.metadata } : {}),
        ...(options?.toolChoice ? { tool_choice: options.toolChoice } : {})
      };
      ours.last = `mandate_response_${++ours.next}`;
      ws.send(JSON.stringify(Object.keys(response).length > 0
        ? { type: "response.create", event_id: ours.last, response }
        : { type: "response.create", event_id: ours.last }));
    },
    updateInstructions(text: string) {
      // A partial session.update changes only the fields it carries.
      ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime", instructions: text } }));
    },
    cancelResponse() {
      ws.send(JSON.stringify({ type: "response.cancel" }));
    },
    truncateItem(itemId: string, audioEndMs: number) {
      ws.send(JSON.stringify({
        type: "conversation.item.truncate",
        item_id: itemId,
        content_index: 0,
        audio_end_ms: audioEndMs
      }));
    },
    preloadHistory(items) {
      for (const it of items) {
        ws.send(JSON.stringify(buildMessageItem(it.role, it.text)));
      }
    },
    async close() {
      try { ws.close(1000, "client done"); } catch { /* ignore */ }
    }
  };
}

function buildMessageItem(role: "user" | "assistant", text: string): unknown {
  // GA schema: user content is `input_text`, assistant content is `output_text`.
  const contentPart = role === "user"
    ? { type: "input_text", text }
    : { type: "output_text", text };
  return {
    type: "conversation.item.create",
    item: { type: "message", role, content: [contentPart] }
  };
}

function handleEvent(data: string, _ws: RealtimeWebSocket, events: VoiceSessionEvents, ours: { last: string | null }): void {
  let event: unknown;
  try { event = JSON.parse(data); } catch { return; }
  if (!isRecord(event) || typeof event.type !== "string") return;
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      events.onSpeechStarted();
      return;
    case "input_audio_buffer.speech_stopped":
      events.onSpeechStopped();
      return;
    case "response.created": {
      const response = isRecord(event.response) ? event.response : {};
      events.onResponseCreated({ responseId: stringOrNull(response.id), metadata: metadataOf(response.metadata) });
      return;
    }
    case "response.output_item.added": {
      const item = isRecord(event.item) ? event.item : {};
      if (
        item?.type === "message" &&
        item?.role === "assistant" &&
        typeof item.id === "string"
      ) {
        events.onResponseItemAdded({ itemId: item.id });
      }
      return;
    }
    case "response.done":
    case "response.cancelled": {
      const response = isRecord(event.response) ? event.response : {};
      events.onResponseDone({
        responseId: stringOrNull(response.id) ?? stringOrNull(event.response_id),
        status: stringOrNull(response.status) ?? (event.type === "response.cancelled" ? "cancelled" : null)
      });
      return;
    }
    case "response.output_audio.delta": {
      const pcm = base64ToArrayBuffer(typeof event.delta === "string" ? event.delta : "");
      events.onAudio({ pcm, sampleRate: 24000, channels: 1 });
      return;
    }
    case "response.output_audio_transcript.delta":
      events.onTranscript({ speaker: "assistant", text: stringValue(event.delta), isFinal: false });
      return;
    case "response.output_audio_transcript.done":
      events.onTranscript({ speaker: "assistant", text: stringValue(event.transcript), isFinal: true }, { responseId: stringOrNull(event.response_id) });
      return;
    case "conversation.item.input_audio_transcription.completed": {
      events.onTranscript({ speaker: "user", text: stringValue(event.transcript), isFinal: true });
      return;
    }
    case "response.function_call_arguments.done": {
      let args: unknown = {};
      try { args = JSON.parse(typeof event.arguments === "string" ? event.arguments : "{}"); } catch { /* keep {} */ }
      events.onToolCall({
        callId: stringValue(event.call_id),
        name: stringValue(event.name),
        args,
        responseId: stringOrNull(event.response_id)
      });
      return;
    }
    case "error": {
      const error = isRecord(event.error) ? event.error : {};
      const message = typeof error.message === "string" ? error.message : "unknown";
      // Not for the UI: a response.create that met a response already under
      // way (server VAD's reply, started as ours was sent). The session
      // decides what the refused request becomes.
      if (message.includes("active response in progress")) {
        events.onResponseRejected("busy");
        return;
      }
      // Any other error our response.create caused (a rate limit, say)
      // refuses it too, and is still an error.
      if (ours.last !== null && error.event_id === ours.last) {
        ours.last = null;
        events.onResponseRejected("error");
      }
      // Barge-in race: response.cancel can land after the response naturally
      // ended (e.g. user starts speaking right as the last audio chunk arrives).
      // OpenAI returns "Cancellation failed: no active response" — harmless.
      if (message.includes("Cancellation failed")) return;
      // conversation.item.truncate against an item already finalized — best-effort.
      if (message.includes("truncation failed")) return;
      events.onError({ kind: "protocol", message });
      return;
    }
  }
}

function createNativeWebSocket(url: string, headers: Record<string, string>): RealtimeWebSocket {
  type BunWebSocketCtor = new (url: string, options?: { headers: Record<string, string> }) => RealtimeWebSocket;
  const ctor = globalThis.WebSocket as BunWebSocketCtor;
  return new ctor(url, { headers });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function metadataOf(value: unknown): VoiceResponseMetadata | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}
