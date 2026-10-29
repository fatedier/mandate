import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ZOOM_DEFAULT, snapZoom } from "@/lib/desktop-zoom";

/** "system" follows the OS / browser preference (the default for a new
 *  install); an explicit choice is remembered as such. */
export type Theme = "system" | "dark" | "light";

export interface RecentPane { sessionName: string; windowName: string; paneId: string; at: string }
export const RECENT_PANES_MAX = 20;

/** Newest first, one entry per pane, capped. Pure so the switcher's tests can
 *  drive it without the store. */
export function pushRecentPane(list: RecentPane[], entry: RecentPane): RecentPane[] {
  return [entry, ...list.filter((x) => x.paneId !== entry.paneId)].slice(0, RECENT_PANES_MAX);
}

interface UIState {
  theme: Theme;
  sidebarCollapsed: boolean;
  /** "Fit width" — terminal font scales so the pane's cols fill the browser
   *  width. Workflow preference, persisted so it carries between panes. */
  terminalFitWidth: boolean;
  /** "Web fit" — request a tmux fit-lease so the window resizes to match
   *  the browser. Persisted across panes. */
  terminalFitBrowser: boolean;
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
  /** The sidebar's Archived group, open or closed as it was left. */
  archivedThreadsOpen: boolean;

  setTheme: (theme: Theme) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTerminalFitWidth: (b: boolean) => void;
  setTerminalFitBrowser: (b: boolean) => void;
  setWorkerPanelRatio: (ratio: number) => void;
  setSidebarWidth: (px: number) => void;
  rememberPane: (entry: Omit<RecentPane, "at">, at?: string) => void;
  /** Drop one pane from the history (the switcher's per-row ×). */
  forgetPane: (paneId: string) => void;
  /** Empty the history (the switcher's Clear). */
  clearRecentPanes: () => void;
  setInterfaceZoom: (factor: number) => void;
  setArchivedThreadsOpen: (open: boolean) => void;
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
      terminalFitWidth: false,
      terminalFitBrowser: false,
      workerPanelRatio: 0.5,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      recentPanes: [],
      interfaceZoom: ZOOM_DEFAULT,
      archivedThreadsOpen: false,

      setTheme: (theme) => set({ theme }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setTerminalFitWidth: (b) => set({ terminalFitWidth: b }),
      setTerminalFitBrowser: (b) => set({ terminalFitBrowser: b }),
      setWorkerPanelRatio: (ratio) => set({ workerPanelRatio: clampRatio(ratio) }),
      setSidebarWidth: (px) => set({ sidebarWidth: clampSidebarWidth(px) }),
      rememberPane: (entry, at) => set((s) => ({
        recentPanes: pushRecentPane(s.recentPanes, { ...entry, at: at ?? new Date().toISOString() })
      })),
      forgetPane: (paneId) => set((s) => ({ recentPanes: s.recentPanes.filter((e) => e.paneId !== paneId) })),
      clearRecentPanes: () => set({ recentPanes: [] }),
      setInterfaceZoom: (factor) => set({ interfaceZoom: snapZoom(factor) }),
      setArchivedThreadsOpen: (open) => set({ archivedThreadsOpen: open })
    }),
    {
      name: "mandate.ui",
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const saved = persisted as Partial<UIState> | undefined;
        return {
          ...current,
          ...saved,
          workerPanelRatio: clampRatio(saved?.workerPanelRatio),
          // Element-level guard: a hand-edited or half-written store could hold
          // `null` or a string, and the switcher reads `entry.sessionName`.
          recentPanes: Array.isArray(saved?.recentPanes)
            ? saved.recentPanes.filter((e): e is RecentPane => !!e && typeof e === "object" && typeof (e as RecentPane).paneId === "string")
            : current.recentPanes,
          // Snap to the ladder: a value between steps would need two presses
          // to visibly move, and a non-number would zoom the webview to NaN.
          interfaceZoom: snapZoom(typeof saved?.interfaceZoom === "number" ? saved.interfaceZoom : current.interfaceZoom),
          // An explicit dark/light choice from before "system" existed is kept;
          // anything else (absent, or a stray value) follows the system.
          theme: saved?.theme === "dark" || saved?.theme === "light" ? saved.theme : "system",
          archivedThreadsOpen: saved?.archivedThreadsOpen === true
        };
      },
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        terminalFitWidth: state.terminalFitWidth,
        terminalFitBrowser: state.terminalFitBrowser,
        workerPanelRatio: state.workerPanelRatio,
        sidebarWidth: state.sidebarWidth,
        recentPanes: state.recentPanes,
        interfaceZoom: state.interfaceZoom,
        archivedThreadsOpen: state.archivedThreadsOpen
      })
    }
  )
);
