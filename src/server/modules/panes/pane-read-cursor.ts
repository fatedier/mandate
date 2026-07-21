import { paneLineSet } from "./pane-read-collapse.js";

export const PANE_CURSOR_MAX_ENTRIES = 200;

interface PaneCursorEntry {
  lines: Set<string>;
  zeroNewStreak: number;
}

/**
 * Per-(thread, pane) memory of what read_pane last returned, so the next read
 * can skip repeating it. Process-local and deliberately not persisted: a
 * restart just costs one full read, whereas a dropped watch_window strands an
 * agent that asked to be woken — which is why watches are persisted and this
 * is not. (This comment used to claim the two shared a contract; they no
 * longer do.)
 */
export class PaneReadCursorStore {
  private entries = new Map<string, PaneCursorEntry>();

  get(threadId: string, paneId: string): PaneCursorEntry | null {
    const key = cursorKey(threadId, paneId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Re-insert to mark it most-recently-used for the eviction sweep below.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /** Store the FULL capture (not the collapsed output) and return the new idle streak. */
  remember(threadId: string, paneId: string, fullText: string, hasNew: boolean): number {
    const key = cursorKey(threadId, paneId);
    const previous = this.entries.get(key);
    const zeroNewStreak = hasNew ? 0 : (previous?.zeroNewStreak ?? 0) + 1;
    this.entries.delete(key);
    this.entries.set(key, { lines: paneLineSet(fullText), zeroNewStreak });
    while (this.entries.size > PANE_CURSOR_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return zeroNewStreak;
  }

  /** Forget one pane: used when the agent is not being given the text we captured. */
  forget(threadId: string, paneId: string): void {
    this.entries.delete(cursorKey(threadId, paneId));
  }

  /** Compression may have summarized away the messages holding those lines. */
  resetThread(threadId: string): void {
    const prefix = `${threadId}|`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

function cursorKey(threadId: string, paneId: string): string {
  return `${threadId}|${paneId}`;
}

export const paneReadCursors = new PaneReadCursorStore();
