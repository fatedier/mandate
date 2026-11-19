import type { PersistStorage, StorageValue } from "zustand/middleware";

function read<S>(name: string): StorageValue<S> | null {
  try {
    const raw = localStorage.getItem(name);
    return raw ? (JSON.parse(raw) as StorageValue<S>) : null;
  } catch {
    return null;
  }
}

/** localStorage for a zustand store whose saved state other windows of this
 *  browser write too: each save first passes through `keep` with what is
 *  saved now, so a store can keep what another window wrote since (a newer
 *  tab order) instead of writing its own older copy over it. */
export function storageKeeping<S>(keep: (saving: S, saved: S | null) => S): PersistStorage<S> {
  return {
    getItem: (name) => read<S>(name),
    setItem: (name, value) => {
      localStorage.setItem(name, JSON.stringify({ ...value, state: keep(value.state, read<S>(name)?.state ?? null) }));
    },
    removeItem: (name) => localStorage.removeItem(name)
  };
}
