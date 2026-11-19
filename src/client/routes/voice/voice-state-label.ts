import type { VoiceConnectionState } from "@/store/voice";

/** What voice is doing, in the words the dock, the strip and the bar use. */
export const VOICE_STATE_LABEL: Partial<Record<VoiceConnectionState, string>> = {
  "requesting-mic": "Connecting…",
  connecting: "Connecting…",
  listening: "Listening",
  speaking: "Speaking",
  reconnecting: "Reconnecting…",
  moved: "Moved to another device",
  error: "Voice error"
};
