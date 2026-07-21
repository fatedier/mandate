import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Theme = "dark" | "light";
export type VoiceInputMode = "vad" | "ptt";
export type PillPosition = { side: "left" | "right"; topPx: number };

interface UIState {
  theme: Theme;
  sidebarCollapsed: boolean;
  voiceInputMode: VoiceInputMode;
  pillPosition: PillPosition;
  /** "Fit width" — terminal font scales so the pane's cols fill the browser
   *  width. Workflow preference, persisted so it carries between panes. */
  terminalFitWidth: boolean;
  /** "Web fit" — request a tmux fit-lease so the window resizes to match
   *  the browser. Persisted across panes. */
  terminalFitBrowser: boolean;
  /** Chat's share of the workspace after the sidebar. */
  chatPanelRatio: number;
  /** Desktop sidebar width in pixels. User-resizable via the drag handle on its
   *  right edge, mirroring the chat drawer's on the left. Ignored while
   *  collapsed, where the rail is a fixed 48px. */
  sidebarWidth: number;

  setTheme: (theme: Theme) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setVoiceInputMode: (mode: VoiceInputMode) => void;
  setPillPosition: (pos: PillPosition) => void;
  setTerminalFitWidth: (b: boolean) => void;
  setTerminalFitBrowser: (b: boolean) => void;
  setChatPanelRatio: (ratio: number) => void;
  setSidebarWidth: (px: number) => void;
}

export const CHAT_PANEL_WIDTH_MIN = 320;
export const CHAT_PANEL_WIDTH_DEFAULT = 480;

/** 180 is the narrowest that still fits an icon, a gap and a readable label;
 *  below it the nav rows stop being rows. 224 is w-56, the fixed width the
 *  sidebar had before it was resizable, so an untouched install does not move. */
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 420;
export const SIDEBAR_WIDTH_DEFAULT = 224;

function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(px)));
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: "dark",
      sidebarCollapsed: false,
      voiceInputMode: "vad",
      pillPosition: { side: "right", topPx: -1 },
      terminalFitWidth: false,
      terminalFitBrowser: false,
      chatPanelRatio: 0.5,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,

      setTheme: (theme) => set({ theme }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setVoiceInputMode: (mode) => set({ voiceInputMode: mode }),
      setPillPosition: (pos) => set({ pillPosition: pos }),
      setTerminalFitWidth: (b) => set({ terminalFitWidth: b }),
      setTerminalFitBrowser: (b) => set({ terminalFitBrowser: b }),
      setChatPanelRatio: (ratio) => set({
        chatPanelRatio: Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0.5
      }),
      setSidebarWidth: (px) => set({ sidebarWidth: clampSidebarWidth(px) })
    }),
    {
      name: "ap.ui",
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const saved = persisted as Partial<UIState> | undefined;
        return {
          ...current,
          ...saved,
          chatPanelRatio: saved?.chatPanelRatio ?? current.chatPanelRatio
        };
      },
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        voiceInputMode: state.voiceInputMode,
        pillPosition: state.pillPosition,
        terminalFitWidth: state.terminalFitWidth,
        terminalFitBrowser: state.terminalFitBrowser,
        chatPanelRatio: state.chatPanelRatio,
        sidebarWidth: state.sidebarWidth
      })
    }
  )
);
