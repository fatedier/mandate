import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { clampRatio } from "./ui";
import { canvasIdOfTab, canvasTabId } from "@/lib/panel-tabs";

interface AgentPageUiState {
  /** The page is shown beside the chat. */
  open: boolean;
  /** The page has the whole row. */
  maximized: boolean;
  /** The page's share of the row. */
  ratio: number;
  /** The row is narrow: one side at a time (not kept). */
  narrow: boolean;
  /** In a narrow row, the side in sight (not kept). */
  narrowView: "chat" | "side";
  /** The canvases open as tabs after Page, in the order opened. */
  tabs: string[];
  /** The tab in sight: "page", or one of `tabs`. */
  active: "page" | string;
  setOpen(open: boolean): void;
  setMaximized(maximized: boolean): void;
  setRatio(ratio: number): void;
  setNarrow(narrow: boolean): void;
  setNarrowView(view: "chat" | "side"): void;
  /** A canvas as a tab, at the end unless open already; the side shows it
   *  (a narrow row turns to it). */
  openCanvas(canvasId: string): void;
  /** Its left neighbour opens when it was open, else Page. */
  closeTab(tabId: string): void;
  setActive(tabId: "page" | string): void;
}

/** How Your agent's page sits beside its chat. Open, full screen and its
 *  share of the row are remembered; which side a narrow row shows is not. */
export const useAgentPageUi = create<AgentPageUiState>()(
  persist(
    (set) => ({
      open: true,
      maximized: false,
      ratio: 0.5,
      narrow: false,
      narrowView: "chat",
      setOpen: (open) => set({ open }),
      setMaximized: (maximized) => set({ maximized }),
      setRatio: (ratio) => set({ ratio: clampRatio(ratio) }),
      setNarrow: (narrow) => set({ narrow }),
      setNarrowView: (narrowView) => set({ narrowView }),
      tabs: [],
      active: "page",
      openCanvas: (canvasId) => {
        const id = canvasTabId(canvasId);
        set((s) => ({ open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id, ...(s.narrow ? { narrowView: "side" as const } : {}) }));
      },
      closeTab: (tabId) => set((s) => {
        const index = s.tabs.indexOf(tabId);
        const tabs = s.tabs.filter((t) => t !== tabId);
        return { tabs, active: s.active !== tabId ? s.active : (tabs[Math.max(0, index - 1)] ?? "page") };
      }),
      setActive: (active) => set({ active })
    }),
    {
      name: "mandate.agent-page.v1",
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const saved = persisted as Partial<AgentPageUiState> | undefined;
        // Only canvas tabs: anything else saved there names nothing.
        const tabs = Array.isArray(saved?.tabs)
          ? saved.tabs.filter((tab): tab is string => typeof tab === "string" && canvasIdOfTab(tab) !== null)
          : [];
        return {
          ...current,
          open: typeof saved?.open === "boolean" ? saved.open : current.open,
          maximized: saved?.maximized === true,
          ratio: clampRatio(saved?.ratio),
          tabs,
          active: typeof saved?.active === "string" && tabs.includes(saved.active) ? saved.active : "page"
        };
      },
      partialize: (state) => ({ open: state.open, maximized: state.maximized, ratio: state.ratio, tabs: state.tabs, active: state.active })
    }
  )
);
