import { Mutex } from "async-mutex";

/**
 * Work that runs alone for its key (a project, a pane, a window), in the order
 * it came. git and tmux run while the server goes on, so two requests can
 * otherwise interleave between checking tmux or git and changing it: both
 * find no window and both open one. Work for other keys runs side by side; a
 * key nobody holds or waits for is forgotten. Not re-entrant: work that runs
 * for a key and asks for the same key again waits for itself forever.
 */
export interface KeyedExclusion {
  run<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
  /** Keys held or waited for: for tests. */
  size(): number;
}

export function createKeyedExclusion(): KeyedExclusion {
  const keys = new Map<string, { mutex: Mutex; users: number }>();
  return {
    async run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
      let entry = keys.get(key);
      if (!entry) {
        entry = { mutex: new Mutex(), users: 0 };
        keys.set(key, entry);
      }
      entry.users += 1;
      try {
        return await entry.mutex.runExclusive(fn);
      } finally {
        entry.users -= 1;
        if (entry.users === 0 && keys.get(key) === entry) keys.delete(key);
      }
    },
    size: () => keys.size
  };
}
