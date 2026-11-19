import type { ReactNode } from "react";
import { create } from "zustand";

/** How many of its closed tabs a panel's Reopen lists: the newest that can
 *  come back. */
export const CLOSED_TABS_LISTED = 5;
/** How many a panel keeps: more than it lists, so tabs open again or whose
 *  thing is gone, which are not listed, do not crowd out ones that can come
 *  back. */
export const CLOSED_TABS_KEPT = 20;

/** The personal agent's panel; a thread's is keyed by its thread (threadPanel). */
export const PERSONAL_PANEL = "personal";
export function threadPanel(threadId: string): string {
  return `thread:${threadId}`;
}

/** A tab closed in a right panel, as Reopen lists and opens it again. */
export interface ClosedTab {
  /** Its id in the panel's row. */
  id: string;
  /** Its name and icon when it closed. */
  label: string;
  icon: ReactNode;
  closedAt: number;
  /** The tab before it among the panel's own tabs (not the server's thread
   *  and reply tabs), or null when it led them: it comes back after that one. */
  after: string | null;
  /** The tab before it in the row as drawn (any kind), or null when it led:
   *  where it comes back in an order the person dragged the row into. */
  rowAfter?: string | null;
  /** A reply's tab: what opening it again sends to the server. */
  reply?: { threadId: string; messageId: string; text: string };
  /** A file's tab: the lines it pointed at. */
  lines?: { line?: number; end?: number };
}

interface ClosedTabsState {
  /** Each panel's closed tabs, newest first. */
  byPanel: Record<string, ClosedTab[]>;
  /** Puts `tab` in by when it closed (a new close first), the same tab
   *  closed before taken out: the same id, or for a reply the same reply
   *  (opened again, it has a new tab). */
  record(panel: string, tab: ClosedTab): void;
  forget(panel: string, id: string): void;
}

/**
 * The tabs closed in each right panel, newest first: the panel's Reopen
 * opens them again. In memory only, so a reload starts with none: a reply
 * tab's text can be 200k characters, too much for the browser's storage.
 */
export const useClosedTabsStore = create<ClosedTabsState>((set) => ({
  byPanel: {},
  record: (panel, tab) => set((s) => {
    const rest = (s.byPanel[panel] ?? []).filter((t) => !sameTab(t, tab));
    // Before the ones closed at the same time or earlier: of two closes in
    // one moment, the later recorded is the newer.
    const at = rest.findIndex((t) => t.closedAt <= tab.closedAt);
    const tabs = at < 0 ? [...rest, tab] : [...rest.slice(0, at), tab, ...rest.slice(at)];
    return { byPanel: { ...s.byPanel, [panel]: tabs.slice(0, CLOSED_TABS_KEPT) } };
  }),
  forget: (panel, id) => set((s) => ({
    byPanel: { ...s.byPanel, [panel]: (s.byPanel[panel] ?? []).filter((t) => t.id !== id) }
  }))
}));

function sameTab(a: ClosedTab, b: ClosedTab): boolean {
  if (a.id === b.id) return true;
  return a.reply !== undefined && b.reply !== undefined && a.reply.threadId === b.reply.threadId && a.reply.messageId === b.reply.messageId;
}
