// src/server/modules/voice/voice-provider.ts
import type { ToolDefinition } from "../agent/tool-registry.js";

type VoiceLanguage = "auto" | string;

/** OpenAI Realtime's transcription config (Whisper-backed) takes ISO-639-1
 *  codes. Mandate stores `voice.language` as either `"auto"`, an ISO code,
 *  or a human-readable display name. Map the display names we recognise
 *  to codes so the same field can drive both
 *  ASR hint (this helper) and reply-language directive (the system
 *  prompt). Returns null when the language is auto / unrecognised — the
 *  caller should omit the transcription `language` field in that case so
 *  Whisper auto-detects. */
export function languageToIsoCode(language: string | null | undefined): string | null {
  if (!language) return null;
  const lower = language.toLowerCase().trim();
  if (lower === "" || lower === "auto" || lower === "automatic") return null;
  if (/^[a-z]{2}$/.test(lower)) return lower;
  if (/(simplified |traditional )?chinese|中文|普通话|国语|粤语|cantonese|mandarin/.test(lower)) return "zh";
  if (/english/.test(lower)) return "en";
  if (/japanese|日本語|nihongo/.test(lower)) return "ja";
  if (/korean|한국어/.test(lower)) return "ko";
  if (/spanish|español|castellano/.test(lower)) return "es";
  if (/french|français/.test(lower)) return "fr";
  if (/german|deutsch/.test(lower)) return "de";
  if (/portuguese|português/.test(lower)) return "pt";
  if (/russian|русский/.test(lower)) return "ru";
  if (/italian|italiano/.test(lower)) return "it";
  if (/arabic|العربية/.test(lower)) return "ar";
  if (/hindi|हिन्दी/.test(lower)) return "hi";
  if (/dutch|nederlands/.test(lower)) return "nl";
  if (/turkish|türkçe/.test(lower)) return "tr";
  if (/polish|polski/.test(lower)) return "pl";
  if (/vietnamese|tiếng việt/.test(lower)) return "vi";
  if (/thai|ไทย/.test(lower)) return "th";
  if (/indonesian|bahasa indonesia/.test(lower)) return "id";
  return null;
}

export interface VoiceProviderConfig {
  providerName?: string;
  providerType?: string;
  apiKey: string;
  model: string;
  voice: string;
  language: VoiceLanguage;
  systemPrompt: string;
  /** Mandate-internal tool definitions that the session should expose to the
   *  provider. The provider implementation translates each into its own
   *  function schema format. */
  tools: ToolDefinition[];
}

/** A pending tool call from the provider — argument JSON has already been
 *  validated as syntactically valid by the provider; semantic validation
 *  (against the tool's zod schema) happens server-side at dispatch time. */
interface VoiceToolCall {
  callId: string;
  name: string;
  args: unknown;
  /** The response that asked for it. */
  responseId?: string | null;
}

/** What a client tags its own response.create with (`response.metadata`),
 *  echoed on the response's server events. */
export type VoiceResponseMetadata = Record<string, string>;

/** Single audio frame in PCM16 (signed 16-bit, little-endian) at the sample
 *  rate the provider negotiated. OpenAI Realtime uses 24kHz mono by default. */
export interface VoiceAudioFrame {
  pcm: ArrayBuffer;
  sampleRate: number;
  channels: 1;
}

export interface VoiceTranscriptDelta {
  speaker: "user" | "assistant";
  text: string;
  /** Marks the tail of an utterance so the client can flush its on-screen line. */
  isFinal: boolean;
}

interface PreloadItem {
  role: "user" | "assistant";
  text: string;
}

export type VoiceProviderError =
  | { kind: "auth"; message: string }
  | { kind: "rate-limit"; message: string }
  | { kind: "network"; message: string }
  | { kind: "protocol"; message: string };

export interface VoiceSessionEvents {
  /** Audio bytes from provider — fan out to viewers (single browser viewer
   *  in v1, but plural-shaped for future flexibility). */
  onAudio: (frame: VoiceAudioFrame) => void;
  /** Transcript delta; a final one is persisted. `source.responseId` is the
   *  response an assistant transcript belongs to. */
  onTranscript: (delta: VoiceTranscriptDelta, source?: { responseId: string | null }) => void;
  /** Provider asked us to invoke a tool. */
  onToolCall: (call: VoiceToolCall) => void;
  /** Server VAD detected user speech start — orchestrator decides whether to
   *  cancel + truncate the in-flight response. */
  onSpeechStarted: () => void;
  /** Server VAD: the user stopped speaking. The provider answers that
   *  speech by itself next (server VAD's create_response). */
  onSpeechStopped: () => void;
  /** Provider began producing a new model response. Orchestrator uses this
   *  to know there's something to cancel even before the assistant item id
   *  has arrived. `metadata` is what our response.create tagged it with;
   *  null for a response we did not request (server VAD's). */
  onResponseCreated: (info: { responseId: string | null; metadata: VoiceResponseMetadata | null }) => void;
  /** Provider announced the assistant message item id for the current
   *  response. Needed for `truncateItem`. */
  onResponseItemAdded: (info: { itemId: string }) => void;
  /** Current response ended (cleanly, by error, or via cancel). Orchestrator
   *  resets per-response tracking. `status` is the provider's ("completed",
   *  "cancelled", …). */
  onResponseDone: (info: { responseId: string | null; status: string | null }) => void;
  /** Our response.create was refused: "busy", a response was already under
   *  way (that one's events follow); "error", any other refusal (a rate
   *  limit, say), after which no response follows. */
  onResponseRejected: (why: "busy" | "error") => void;
  /** Fatal session error — orchestrator should close. */
  onError: (err: VoiceProviderError) => void;
  /** Provider closed cleanly (e.g. its own session-end signal). */
  onClose: () => void;
}

export interface VoiceSession {
  /** Forward an audio frame from the browser to the provider. */
  sendAudio(frame: VoiceAudioFrame): void;
  /** Add a tool's output to the conversation for a previously seen tool
   *  call. When `errorMessage` is set, sends an error payload; otherwise
   *  sends `result` as the function output. Asks for no response:
   *  requestResponse does, once. */
  sendToolResult(callId: string, payload: { result?: unknown; errorMessage?: string }): void;
  /** Add Mandate-generated context (a spoken update) to the conversation as
   *  a user item. Asks for no response. */
  sendContextMessage(text: string): void;
  /** Ask the model for a response (response.create). `metadata` tags it so
   *  its events can be told apart; `toolChoice: "none"` keeps this one
   *  response from calling tools. */
  requestResponse(options?: { metadata?: VoiceResponseMetadata; toolChoice?: "none" }): void;
  /** Replace the session's instructions (the runtime context changed). */
  updateInstructions(text: string): void;
  /** Cancel the current model response (e.g. user interrupted). */
  cancelResponse(): void;
  /** Truncate an assistant message item to `audioEndMs` of audio. The model's
   *  internal record of what it said is rewritten to match what the user
   *  actually heard. Best-effort: failures (e.g. item already finalized) are
   *  swallowed by the provider. */
  truncateItem(itemId: string, audioEndMs: number): void;
  /** Send dialogue history to the realtime conversation before audio starts.
   *  Each item is mapped to a `conversation.item.create` event. Caller filters
   *  out tool/summary content; this method assumes plain text dialogue only. */
  preloadHistory(items: PreloadItem[]): void;
  close(): Promise<void>;
}

export interface VoiceProvider {
  /** Open a new session with the provider. Resolves once the provider has
   *  acknowledged session.update + tool registration, ready for audio.
   *  Rejects (its pending connection closed) when it fails, does not answer
   *  in time, or `signal` aborts. */
  startSession(config: VoiceProviderConfig, events: VoiceSessionEvents, signal?: AbortSignal): Promise<VoiceSession>;
}
