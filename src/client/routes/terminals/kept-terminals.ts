import { useEffect } from "react";
import { create } from "zustand";

/** How many terminals stay connected while another tab shows: a phone's
 *  fewer, as each one hidden still takes its output. Fitted to the browser,
 *  a hidden one keeps its window fitted too, and asks for its fit again when
 *  it shows (LiveTerminal). */
export const KEPT_TERMINALS = { desktop: 5, phone: 3 } as const;

/** The Terminals page's addresses: the shell keeps the page running for
 *  TERMINALS_PAGE_KEPT_MS after another page is opened (KeptAlivePage), so
 *  its terminals stay connected for the way back, but not for good. */
export const TERMINALS_PAGE_PATHS = ["/terminals", "/terminals/pane/:paneId"] as const;
export const TERMINALS_PAGE_KEPT_MS = 10 * 60 * 1000;

export function keptTerminalLimit(phone: boolean): number {
  return phone ? KEPT_TERMINALS.phone : KEPT_TERMINALS.desktop;
}

interface KeptTerminalsState {
  /** Per place (the Terminals page, the personal agent's panel): the
   *  terminals shown, the last first. */
  byPlace: Record<string, readonly string[]>;
  shown(place: string, key: string, keep: number): void;
  /** Lets go of those whose tab is gone. */
  only(place: string, keys: ReadonlySet<string>): void;
}

const NONE: readonly string[] = [];

const useKeptTerminalsStore = create<KeptTerminalsState>()((set, get) => ({
  byPlace: {},
  shown: (place, key, keep) => {
    const before = get().byPlace[place] ?? NONE;
    const next = [key, ...before.filter((k) => k !== key)].slice(0, keep);
    if (next.length === before.length && next.every((k, i) => k === before[i])) return;
    set({ byPlace: { ...get().byPlace, [place]: next } });
  },
  only: (place, keys) => {
    const before = get().byPlace[place] ?? NONE;
    const next = before.filter((k) => keys.has(k));
    if (next.length !== before.length) set({ byPlace: { ...get().byPlace, [place]: next } });
  }
}));

/** The terminals a place keeps mounted: the one shown and the last ones
 *  shown before it, at most `keep`, in a fixed order (an element moved in
 *  the page would redraw its terminal). `tabs` are the keys that still have
 *  a tab. */
export function useKeptTerminals(place: string, shown: string | null, keep: number, tabs: readonly string[]): string[] {
  const tabKey = tabs.join("\n");
  useEffect(() => {
    if (shown) useKeptTerminalsStore.getState().shown(place, shown, keep);
  }, [place, shown, keep]);
  useEffect(() => {
    useKeptTerminalsStore.getState().only(place, new Set([...tabKey.split("\n"), ...(shown ? [shown] : [])]));
  }, [place, tabKey, shown]);
  const kept = useKeptTerminalsStore((s) => s.byPlace[place] ?? NONE);
  const live = new Set(tabs);
  // Shown before the store has it, and only while its tab is there.
  const keys = [...(shown && !kept.includes(shown) ? [shown] : []), ...kept.filter((k) => k === shown || live.has(k))].slice(0, keep);
  return keys.sort();
}

/** Resets the kept terminals (tests). */
export function resetKeptTerminals(): void {
  useKeptTerminalsStore.setState({ byPlace: {} });
}
