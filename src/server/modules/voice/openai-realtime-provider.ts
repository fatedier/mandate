import { toRealtimeFunctionSchema } from "./voice-tools.js";
import { languageToIsoCode } from "./voice-provider.js";
import type {
  VoiceProvider, VoiceProviderConfig, VoiceSession,
  VoiceSessionEvents, VoiceAudioFrame, VoiceProviderError
} from "./voice-provider.js";

const DEFAULT_OPENAI_URL = "wss://api.openai.com/v1/realtime";

export interface OpenAIRealtimeProviderDeps {
  /** Optional injection hook for tests. Defaults to native WebSocket. */
  wsFactory?: (url: string, headers: Record<string, string>) => RealtimeWebSocket;
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

  async startSession(config: VoiceProviderConfig, events: VoiceSessionEvents): Promise<VoiceSession> {
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
    const headers = this.deps.resolveAuthHeaders
      ? await this.deps.resolveAuthHeaders(config, { baseURL, isAzure })
      : defaultAuthHeaders(config, isAzure);
    const ws: RealtimeWebSocket = this.deps.wsFactory
      ? this.deps.wsFactory(url, headers)
      : createNativeWebSocket(url, headers);

    return new Promise((resolve, reject) => {
      let handshakeFinished = false;
      const fail = (err: VoiceProviderError) => {
        if (handshakeFinished) {
          events.onError(err);
          return;
        }
        handshakeFinished = true;
        reject(new Error(`${err.kind}: ${err.message}`));
      };

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
          handshakeFinished = true;
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

function defaultAuthHeaders(config: VoiceProviderConfig, isAzure: boolean): Record<string, string> {
  if (isAzure) {
    return { "api-key": config.apiKey };
  }
  return { Authorization: `Bearer ${config.apiKey}` };
}

function buildSession(ws: RealtimeWebSocket, events: VoiceSessionEvents, _voice: string): VoiceSession {
  ws.onmessage = (msg: { data: string }) => handleEvent(msg.data, ws, events);
  // Session-level audio.output.voice is sticky once set. _voice is kept in
  // the signature for future provider variants that support per-response
  // overrides.
  const responseCreate = JSON.stringify({ type: "response.create" });
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
      ws.send(responseCreate);
    },
    sendContextMessage(text: string) {
      ws.send(JSON.stringify(buildMessageItem("user", text)));
      ws.send(responseCreate);
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

function handleEvent(data: string, _ws: RealtimeWebSocket, events: VoiceSessionEvents): void {
  let event: unknown;
  try { event = JSON.parse(data); } catch { return; }
  if (!isRecord(event) || typeof event.type !== "string") return;
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      events.onSpeechStarted();
      return;
    case "response.created":
      events.onResponseCreated();
      return;
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
    case "response.cancelled":
      events.onResponseDone();
      return;
    case "response.output_audio.delta": {
      const pcm = base64ToArrayBuffer(typeof event.delta === "string" ? event.delta : "");
      events.onAudio({ pcm, sampleRate: 24000, channels: 1 });
      return;
    }
    case "response.output_audio_transcript.delta":
      events.onTranscript({ speaker: "assistant", text: stringValue(event.delta), isFinal: false });
      return;
    case "response.output_audio_transcript.done":
      events.onTranscript({ speaker: "assistant", text: stringValue(event.transcript), isFinal: true });
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
        args
      });
      return;
    }
    case "error": {
      const error = isRecord(event.error) ? event.error : {};
      const message = typeof error.message === "string" ? error.message : "unknown";
      // Benign noise: when the model emits audio + a function_call together,
      // we fire response.create after sendToolResult while the prior response
      // is still streaming. The server queues the function_call_output and the
      // in-flight response keeps going — only the redundant response.create is
      // rejected. Don't surface this to the UI.
      if (message.includes("active response in progress")) return;
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

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function createNativeWebSocket(url: string, headers: Record<string, string>): RealtimeWebSocket {
  type BunWebSocketCtor = new (url: string, options?: { headers: Record<string, string> }) => RealtimeWebSocket;
  const ctor = globalThis.WebSocket as BunWebSocketCtor;
  return new ctor(url, { headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
