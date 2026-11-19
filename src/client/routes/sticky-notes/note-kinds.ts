import { Clock, Eye, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { StickyNoteKind } from "@shared/api/sticky-notes";

/** Each kind as the page names it, with its mark: the colour is never alone. */
export const NOTE_KIND: Record<StickyNoteKind, { word: string; Icon: LucideIcon }> = {
  alert: { word: "Alert", Icon: TriangleAlert },
  check: { word: "To check", Icon: Eye },
  fyi: { word: "FYI", Icon: Info },
  later: { word: "Later", Icon: Clock }
};
