import { create } from "zustand";

interface SettingsSearchState {
  query: string;
  setQuery: (query: string) => void;
  clear: () => void;
}

/**
 * Settings' search query, shared so the sidebar can mark no section while the
 * matches, which span sections, are what the page shows. SettingsPage clears
 * it on every navigation and when it unmounts.
 *
 * Not in the URL: the router applies a URL in a transition, so a box fed from
 * ?q= put its old value back after each key, and a write built on the URL
 * undid one still pending.
 */
export const useSettingsSearchStore = create<SettingsSearchState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
  clear: () => set({ query: "" })
}));
