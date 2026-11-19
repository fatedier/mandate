import { act } from "react";
import { useStickyNotesStore } from "../../src/client/store/sticky-notes.js";

/** The sticky notes store back to empty: nothing sent yet. */
export function resetStickyNotesStore(): void {
  act(() => { useStickyNotesStore.setState({ open: null, done: new Map() }); });
}
