import { create } from "zustand";

type VoiceConnectionState =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "ready"
  | "speaking"
  | "listening"
  | "closed"
  | "error";

export interface VoiceTranscriptLine {
  speaker: "user" | "assistant";
  text: string;
  isFinal: boolean;
  createdAt: number;
}

interface VoiceStoreState {
  /** True when overview drawer is in voice mode (mic active, ChatInput hidden). */
  voiceMode: boolean;
  connectionState: VoiceConnectionState;
  errorMessage: string | null;
  micLevel: number; // 0..1
  micMuted: boolean;
  modelSpeaking: boolean;
  sessionStartedAt: number | null;
  /** Ephemeral in-progress streaming transcripts, keyed by speaker.
   *  Two slots, one per speaker. Each holds the text accumulated from
   *  isFinal:false deltas; cleared on isFinal:true (the persisted final
   *  arrives via agentMessageAppended SSE separately). */
  inProgressLines: { user: VoiceTranscriptLine | null; assistant: VoiceTranscriptLine | null };

  setVoiceMode: (b: boolean) => void;
  setConnectionState: (s: VoiceConnectionState) => void;
  setError: (msg: string | null) => void;
  setMicLevel: (n: number) => void;
  setMicMuted: (muted: boolean) => void;
  toggleMicMuted: () => void;
  setModelSpeaking: (b: boolean) => void;
  appendInProgressDelta: (speaker: "user" | "assistant", chunk: string) => void;
  clearInProgress: (speaker: "user" | "assistant") => void;
}

const initialInProgress = { user: null, assistant: null };

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  voiceMode: false,
  connectionState: "idle",
  errorMessage: null,
  micLevel: 0,
  micMuted: false,
  modelSpeaking: false,
  sessionStartedAt: null,
  inProgressLines: initialInProgress,

  setVoiceMode: (voiceMode) => {
    if (!voiceMode) {
      // Leaving voice mode — clear ephemeral state. Persisted messages
      // (already in agent_messages) remain.
      set({
        voiceMode: false,
        connectionState: "idle",
        errorMessage: null,
        micLevel: 0,
        micMuted: false,
        modelSpeaking: false,
        sessionStartedAt: null,
        inProgressLines: initialInProgress
      });
    } else {
      set({ voiceMode: true, micMuted: false });
    }
  },
  setConnectionState: (connectionState) => {
    if (connectionState === "ready" && get().sessionStartedAt === null) {
      set({ connectionState, sessionStartedAt: Date.now() });
    } else {
      set({ connectionState });
    }
  },
  setError: (errorMessage) => set({ errorMessage }),
  setMicLevel: (micLevel) => set({ micLevel }),
  setMicMuted: (micMuted) => set({ micMuted, micLevel: micMuted ? 0 : get().micLevel }),
  toggleMicMuted: () => {
    const micMuted = !get().micMuted;
    set({ micMuted, micLevel: micMuted ? 0 : get().micLevel });
  },
  setModelSpeaking: (modelSpeaking) => set({ modelSpeaking }),
  appendInProgressDelta: (speaker, chunk) =>
    set((s) => {
      const existing = s.inProgressLines[speaker];
      const next: VoiceTranscriptLine = existing
        ? { ...existing, text: existing.text + chunk }
        : { speaker, text: chunk, isFinal: false, createdAt: Date.now() };
      return {
        inProgressLines: { ...s.inProgressLines, [speaker]: next }
      };
    }),
  clearInProgress: (speaker) =>
    set((s) => ({
      inProgressLines: { ...s.inProgressLines, [speaker]: null }
    }))
}));
