import { useMemo } from "react";
import { useStickyNotesStore } from "@/store/sticky-notes";

/** How many of the agent's open sticky notes the user has not seen yet: the
 *  count the sidebar's Notes and the panel's tab show. */
export function useUnseenNotes(): number {
  const open = useStickyNotesStore((s) => s.open);
  return useMemo(() => [...(open?.values() ?? [])].filter((note) => !note.seen).length, [open]);
}
