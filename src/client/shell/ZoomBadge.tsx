import { useEffect, useRef, useState } from "react";
import { formatZoom } from "@/lib/desktop-zoom";
import { isTauriRuntime } from "@/lib/runtime";
import { useUIStore } from "@/store/ui";

export const ZOOM_BADGE_MS = 1200;

/** A one-second badge at the top centre after every zoom step — "125% · ⌘0
 *  resets" — so a keypress has visible feedback beyond the page itself
 *  changing size. Desktop shell only; never shown for the boot-time value. */
export function ZoomBadge({ durationMs = ZOOM_BADGE_MS }: { durationMs?: number }) {
  const zoom = useUIStore((s) => s.interfaceZoom);
  const [shown, setShown] = useState<number | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setShown(zoom);
    const timer = setTimeout(() => setShown(null), durationMs);
    return () => clearTimeout(timer);
  }, [zoom, durationMs]);
  if (!isTauriRuntime() || shown === null) return null;
  return (
    <div
      role="status"
      data-slot="zoom-badge"
      className="pointer-events-none fixed left-1/2 top-12 z-[60] flex h-7 -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-popover px-2.5 text-xs text-foreground shadow-md"
    >
      <span className="num font-medium">{formatZoom(shown)}</span>
      <span className="text-faint">⌘0 resets</span>
    </div>
  );
}
