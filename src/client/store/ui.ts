import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ZOOM_DEFAULT, snapZoom } from "@/lib/desktop-zoom";

/** "system" follows the OS / browser preference (the default for a new
 *  install); an explicit choice is remembered as such. */
export type Theme = "system" | "dark" | "light";

export interface RecentPane { sessionName: string; paneId: string }
export const RECENT_PANES_MAX = 20;

/** Newest first, one entry per pane, capped. Pure so the switcher's tests can
 *  drive it without the store. */
export function pushRecentPane(list: RecentPane[], entry: RecentPane): RecentPane[] {
  return [entry, ...list.filter((x) => x.paneId !== entry.paneId)].slice(0, RECENT_PANES_MAX);
}

/** How a terminal shows its pane. `auto`: sized to this screen, until a
 *  terminal on the pane's window is used after it (then the pane's own
 *  size, until this one is used again); `screen`: always sized to this
 *  screen; `pane`: the pane's own size, tmux left as it is; `small`: that,
 *  in text small enough to show the whole width (a phone's only). */
export type TerminalDisplay = "auto" | "screen" | "pane" | "small";
const TERMINAL_DISPLAYS: readonly TerminalDisplay[] = ["auto", "screen", "pane", "small"];

interface UIState {
  theme: Theme;
  sidebarCollapsed: boolean;
  /** Every terminal's Display on this device, carried between panes. */
  terminalDisplay: TerminalDisplay;
  /** The worker panel's share of a thread page's row, beside its chat. */
  workerPanelRatio: number;
  /** Desktop sidebar width in pixels. User-resizable via the drag handle on its
   *  right edge, mirroring the chat drawer's on the left. Ignored while
   *  collapsed, where the rail is a fixed 48px. */
  sidebarWidth: number;
  /** Panes opened on this device, newest first (the terminal switcher's Recent group). */
  recentPanes: RecentPane[];
  /** Desktop shell interface zoom (1 = 100%), one of `ZOOM_STEPS`. Persisted
   *  per machine; the browser build ignores it. */
  interfaceZoom: number;
  /** The side chats under the agent's row in the sidebar, unfolded or
   *  folded (the default) as they were left. */
  personalSideChatsOpen: boolean;
  /** Activity › Breakdown's table, under its charts: open or folded as it
   *  was left. */
  breakdownTableOpen: boolean;

  setTheme: (theme: Theme) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTerminalDisplay: (display: TerminalDisplay) => void;
  setWorkerPanelRatio: (ratio: number) => void;
  setSidebarWidth: (px: number) => void;
  rememberPane: (entry: RecentPane) => void;
  /** Drop one pane from the history (the switcher's per-row ×). */
  forgetPane: (paneId: string) => void;
  /** Empty the history (the switcher's Clear). */
  clearRecentPanes: () => void;
  setInterfaceZoom: (factor: number) => void;
  setPersonalSideChatsOpen: (open: boolean) => void;
  setBreakdownTableOpen: (open: boolean) => void;
}

/** A split ratio in [0, 1]; anything else (absent, NaN, a stray string) is
 *  the equal split. */
export function clampRatio(ratio: unknown): number {
  return typeof ratio === "number" && Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0.5;
}

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
      theme: "system",
      sidebarCollapsed: false,
      terminalDisplay: "auto",
      workerPanelRatio: 0.5,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      recentPanes: [],
      interfaceZoom: ZOOM_DEFAULT,
      personalSideChatsOpen: false,
      breakdownTableOpen: false,

      setTheme: (theme) => set({ theme }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setTerminalDisplay: (display) => set({ terminalDisplay: display }),
      setWorkerPanelRatio: (ratio) => set({ workerPanelRatio: clampRatio(ratio) }),
      setSidebarWidth: (px) => set({ sidebarWidth: clampSidebarWidth(px) }),
      rememberPane: (entry) => set((s) => ({ recentPanes: pushRecentPane(s.recentPanes, entry) })),
      forgetPane: (paneId) => set((s) => ({ recentPanes: s.recentPanes.filter((e) => e.paneId !== paneId) })),
      clearRecentPanes: () => set({ recentPanes: [] }),
      setInterfaceZoom: (factor) => set({ interfaceZoom: snapZoom(factor) }),
      setPersonalSideChatsOpen: (open) => set({ personalSideChatsOpen: open }),
      setBreakdownTableOpen: (open) => set({ breakdownTableOpen: open })
    }),
    {
      name: "mandate.ui",
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        // The fit switches Display replaced are left behind: it starts at Auto.
        const { terminalFitBrowser: _fitBrowser, terminalFitWidth: _fitWidth, ...saved } =
          (persisted ?? {}) as Partial<UIState> & { terminalFitBrowser?: unknown; terminalFitWidth?: unknown };
        return {
          ...current,
          ...saved,
          terminalDisplay: TERMINAL_DISPLAYS.includes(saved.terminalDisplay as TerminalDisplay) ? saved.terminalDisplay! : "auto",
          workerPanelRatio: clampRatio(saved.workerPanelRatio),
          // Element-level guard: a hand-edited or half-written store could hold
          // `null` or a string, and the switcher reads `entry.sessionName`.
          recentPanes: Array.isArray(saved.recentPanes)
            ? saved.recentPanes.filter((e): e is RecentPane => !!e && typeof e === "object" && typeof (e as RecentPane).paneId === "string")
            : current.recentPanes,
          // Snap to the ladder: a value between steps would need two presses
          // to visibly move, and a non-number would zoom the webview to NaN.
          interfaceZoom: snapZoom(typeof saved.interfaceZoom === "number" ? saved.interfaceZoom : current.interfaceZoom),
          // An explicit dark/light choice is kept; anything else (absent,
          // "system", or a stray value) follows the system.
          theme: saved.theme === "dark" || saved.theme === "light" ? saved.theme : "system",
          personalSideChatsOpen: saved.personalSideChatsOpen === true,
          breakdownTableOpen: saved.breakdownTableOpen === true
        };
      },
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        terminalDisplay: state.terminalDisplay,
        workerPanelRatio: state.workerPanelRatio,
        sidebarWidth: state.sidebarWidth,
        recentPanes: state.recentPanes,
        interfaceZoom: state.interfaceZoom,
        personalSideChatsOpen: state.personalSideChatsOpen,
        breakdownTableOpen: state.breakdownTableOpen
      })
    }
  )
);
