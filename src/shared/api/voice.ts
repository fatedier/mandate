export const VOICE_CLIENT_MESSAGES = {
  audio: "audio",
  cancel: "cancel"
} as const;

export const VOICE_SERVER_MESSAGES = {
  ready: "ready",
  audio: "audio",
  transcript: "transcript",
  speechStarted: "speech-started",
  error: "error",
  superseded: "superseded",
  closed: "closed",
  /** The provider dropped; the server is opening a new session. */
  reconnecting: "reconnecting",
  resumed: "resumed"
} as const;

type VoiceSpeaker = "user" | "assistant";

export interface VoiceClientAudioMessage {
  type: typeof VOICE_CLIENT_MESSAGES.audio;
  pcm: string;
  sampleRate: number;
  channels?: 1;
}

interface VoiceClientCancelMessage {
  type: typeof VOICE_CLIENT_MESSAGES.cancel;
}

export type VoiceClientMessage =
  | VoiceClientAudioMessage
  | VoiceClientCancelMessage;

export type VoiceServerMessage =
  | { type: typeof VOICE_SERVER_MESSAGES.ready }
  | {
      type: typeof VOICE_SERVER_MESSAGES.audio;
      pcm: string;
      sampleRate: number;
      channels: 1;
    }
  | {
      type: typeof VOICE_SERVER_MESSAGES.transcript;
      speaker: VoiceSpeaker;
      text: string;
      isFinal: boolean;
    }
  | { type: typeof VOICE_SERVER_MESSAGES.speechStarted }
  | { type: typeof VOICE_SERVER_MESSAGES.error; message: string }
  | { type: typeof VOICE_SERVER_MESSAGES.superseded }
  /** `afterMs`: the limit that stopped voice (idle-timeout, max-session-reached). */
  | { type: typeof VOICE_SERVER_MESSAGES.closed; reason: string; afterMs?: number; message?: string }
  | { type: typeof VOICE_SERVER_MESSAGES.reconnecting }
  | { type: typeof VOICE_SERVER_MESSAGES.resumed };
