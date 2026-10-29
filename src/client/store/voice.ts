import { create } from "zustand";

/** Where voice stands: opening, listening or speaking,
 *  reconnecting after a drop, moved to another device (until Resume here),
 *  or failed. */
export type VoiceConnectionState =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "listening"
  | "speaking"
  | "reconnecting"
  | "moved"
  | "error";

export interface VoiceTranscriptLine {
  speaker: "user" | "assistant";
  text: string;
  isFinal: boolean;
  createdAt: number;
}

interface VoiceStoreState {
  /** True while voice is on: it speaks as the global agent, from any page. */
  voiceMode: boolean;
  connectionState: VoiceConnectionState;
  errorMessage: string | null;
  micLevel: number; // 0..1
  micMuted: boolean;
  /** Why voice stopped by itself (a limit, the service gone), until the next
   *  start. */
  stopNotice: string | null;
  /** Bumped by start and Resume here: the session hook opens a new socket. */
  sessionKey: number;
  /** One turn-on of voice, kept through reconnects and Resume here: the
   *  server continues its limits' clocks and says what came back meanwhile. */
  activationId: string | null;
  /** Ephemeral in-progress streaming transcripts, keyed by speaker.
   *  Two slots, one per speaker. Each holds the text accumulated from
   *  isFinal:false deltas; cleared on isFinal:true (the persisted final
   *  arrives via agentMessageAppended SSE separately). */
  inProgressLines: { user: VoiceTranscriptLine | null; assistant: VoiceTranscriptLine | null };

  startVoice: () => void;
  /** Takes voice back from another device. */
  resumeVoice: () => void;
  stopVoice: (notice?: string) => void;
  /** The user read why voice stopped. */
  dismissStopNotice: () => void;
  setConnectionState: (s: VoiceConnectionState) => void;
  setError: (msg: string | null) => void;
  setMicLevel: (n: number) => void;
  setMicMuted: (muted: boolean) => void;
  toggleMicMuted: () => void;
  /** The agent's audio started or ended: speaking / listening, while live. */
  setModelSpeaking: (b: boolean) => void;
  appendInProgressDelta: (speaker: "user" | "assistant", chunk: string) => void;
  clearInProgress: (speaker: "user" | "assistant") => void;
}

const initialInProgress = { user: null, assistant: null };

/** Random enough to tell turn-ons apart; getRandomValues works where
 *  randomUUID needs a secure context (plain http is not one). */
function newActivationId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  voiceMode: false,
  connectionState: "idle",
  errorMessage: null,
  micLevel: 0,
  micMuted: false,
  stopNotice: null,
  sessionKey: 0,
  activationId: null,
  inProgressLines: initialInProgress,

  startVoice: () => set({
    voiceMode: true, micMuted: false, stopNotice: null, errorMessage: null,
    connectionState: "requesting-mic", sessionKey: get().sessionKey + 1, activationId: newActivationId()
  }),
  resumeVoice: () => set({ connectionState: "requesting-mic", errorMessage: null, sessionKey: get().sessionKey + 1 }),
  // Leaving voice clears what was ephemeral; persisted messages stay.
  stopVoice: (notice) => set({
    voiceMode: false, connectionState: "idle", errorMessage: null, micLevel: 0, micMuted: false,
    inProgressLines: initialInProgress, stopNotice: notice ?? null, activationId: null
  }),
  dismissStopNotice: () => set({ stopNotice: null }),
  setConnectionState: (connectionState) => set({ connectionState }),
  setError: (errorMessage) => set({ errorMessage }),
  setMicLevel: (micLevel) => set({ micLevel }),
  setMicMuted: (micMuted) => set({ micMuted, micLevel: micMuted ? 0 : get().micLevel }),
  toggleMicMuted: () => {
    const micMuted = !get().micMuted;
    set({ micMuted, micLevel: micMuted ? 0 : get().micLevel });
  },
  setModelSpeaking: (speaking) => {
    const state = get().connectionState;
    if (state !== "listening" && state !== "speaking") return;
    set({ connectionState: speaking ? "speaking" : "listening" });
  },
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
