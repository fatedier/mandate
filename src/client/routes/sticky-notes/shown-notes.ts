import { create } from "zustand";
import type { StickyNoteDto } from "@shared/api/sticky-notes";

/** A note as one view showed it: a new version is new again. */
export const shownKey = (note: Pick<StickyNoteDto, "id" | "version">) => `${note.id}:${note.version}`;

interface ShownNotesState {
  /** Per Notes view in sight: the notes it showed new, which keep their tape
   *  there until the view goes out of sight (though seen since). */
  byView: ReadonlyMap<string, ReadonlySet<string>>;
  add(view: string, keys: readonly string[]): void;
  clear(view: string): void;
}

export const useShownNotes = create<ShownNotesState>()((set) => ({
  byView: new Map(),
  add: (view, keys) => set((s) => {
    const next = new Map(s.byView);
    next.set(view, new Set([...(s.byView.get(view) ?? []), ...keys]));
    return { byView: next };
  }),
  clear: (view) => set((s) => {
    if (!s.byView.has(view)) return {};
    const next = new Map(s.byView);
    next.delete(view);
    return { byView: next };
  })
}));
