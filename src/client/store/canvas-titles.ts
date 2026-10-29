import { create } from "zustand";
import { CANVAS_ID, CANVAS_TITLES_MAX, type CanvasTitleDto, type CanvasTitlesResponse } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";

/**
 * The names of canvases whose paths an agent wrote, read once and kept: a
 * path drawn in a reply shows its canvas's title. The ids wanted while one
 * frame draws are read together, in one request. A canvas that is not there
 * is kept as null, so its path is shown and it is not asked for again; a read
 * that failed is asked for again the next time the path is drawn. A kept
 * title is read again only when asked (`refresh`: an open tab's canvas
 * changed); elsewhere a renamed canvas shows its old name until the page is
 * reloaded.
 */
interface CanvasTitlesStore {
  titles: ReadonlyMap<string, CanvasTitleDto | null>;
  /** The title is wanted: read with the others wanted now, unless kept. */
  want(id: string): void;
  /** A kept title is read again (its canvas changed); the old one shows
   *  until the new one comes. One never kept is left to `want`. */
  refresh(id: string): void;
}

/** Wanted, to be sent with the next read; and being read now. */
const queued = new Set<string>();
const reading = new Set<string>();
let flush: ReturnType<typeof setTimeout> | null = null;
/** Each id's latest read: an earlier one that answers later is not kept. */
const latest = new Map<string, number>();
let sent = 0;

export const useCanvasTitles = create<CanvasTitlesStore>()((set, get) => {
  const read = async (ids: string[]) => {
    const asked = new Map(ids.map((id) => [id, latest.get(id)]));
    try {
      const res = await fetch(api.canvasTitles(ids));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Exclude<CanvasTitlesResponse, { error: string }>;
      const found = new Map((body.canvases ?? []).map((canvas) => [canvas.id, canvas]));
      set((s) => {
        const titles = new Map(s.titles);
        for (const id of ids) if (latest.get(id) === asked.get(id)) titles.set(id, found.get(id) ?? null);
        return { titles };
      });
    } catch {
      // Unread: the path stays, and is asked for when it is drawn again.
    } finally {
      for (const id of ids) if (latest.get(id) === asked.get(id)) reading.delete(id);
    }
  };
  const schedule = () => {
    if (flush) return;
    flush = setTimeout(() => {
      flush = null;
      const ids = [...queued];
      queued.clear();
      for (const id of ids) { reading.add(id); latest.set(id, ++sent); }
      for (let at = 0; at < ids.length; at += CANVAS_TITLES_MAX) void read(ids.slice(at, at + CANVAS_TITLES_MAX));
    }, 0);
  };
  return {
    titles: new Map(),
    want(id) {
      // Not a canvas's id (a path written to describe the route): nothing to read.
      if (!CANVAS_ID.test(id)) return;
      if (get().titles.has(id) || queued.has(id) || reading.has(id)) return;
      queued.add(id);
      schedule();
    },
    refresh(id) {
      if (!get().titles.has(id) || queued.has(id)) return;
      queued.add(id);
      schedule();
    }
  };
});

/** Back to nothing read: for tests. */
export function resetCanvasTitles(): void {
  if (flush) clearTimeout(flush);
  flush = null;
  queued.clear();
  reading.clear();
  latest.clear();
  useCanvasTitles.setState({ titles: new Map() });
}
