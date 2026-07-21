import type { UiLocation } from "../ui-context.js";

export const VOICE_CLIENT_MESSAGES = {
  audio: "audio",
  cancel: "cancel",
  uiLocation: "ui_location"
} as const;

export const VOICE_SERVER_MESSAGES = {
  ready: "ready",
  audio: "audio",
  transcript: "transcript",
  speechStarted: "speech-started",
  error: "error",
  superseded: "superseded",
  closed: "closed"
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

export interface VoiceClientUiLocationMessage {
  type: typeof VOICE_CLIENT_MESSAGES.uiLocation;
  clientId: string;
  uiLocation: UiLocation;
}

export type VoiceClientMessage =
  | VoiceClientAudioMessage
  | VoiceClientCancelMessage
  | VoiceClientUiLocationMessage;

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
  | { type: typeof VOICE_SERVER_MESSAGES.closed; reason: string };
