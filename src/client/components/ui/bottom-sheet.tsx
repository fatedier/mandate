import { useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer } from "vaul";
import { CloseRequests } from "@/lib/close-requests";
import { cn } from "@/lib/utils";

/** Where a phone sheet rests: half the screen when it opens, all of it (bar a
 *  sliver of what is behind) when pulled up by the handle. Dragging down goes
 *  back to half, then closes. */
const BOTTOM_SHEET_SNAP_POINTS: [number, number] = [0.5, 1];

/** A drag released with less than this share of the screen still showing
 *  closes the sheet. vaul on its own only picks the nearest resting height,
 *  so a slow pull down from half bounced back to half; only a flick closed. */
const BOTTOM_SHEET_CLOSE_BELOW = 0.35;

interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Above the body, below the handle. Must hold a `BottomSheetTitle`, which
   *  names the dialog (visually hidden where the header says it otherwise). */
  header: ReactNode;
  /** Scrolls once the sheet is pulled all the way up; until then a drag moves
   *  the sheet, not what is in it. */
  children: ReactNode;
  slot?: string;
  bodyClassName?: string;
  /** Controlled height: full (true) or half (false). Leave both out and the
   *  sheet keeps its own, starting at half on every opening. */
  full?: boolean;
  onFullChange?: (full: boolean) => void;
  /** Esc, and the phone's Back with it (close-requests.ts): prevented, the
   *  sheet stays open (a sheet with levels steps back one instead). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Where focus goes back to once it closes, for a sheet opened from a
   *  control that is not its trigger (a menu item): without it, focus is
   *  left on the page itself. A function is asked as it closes, for a
   *  control that may have been drawn anew meanwhile. */
  returnFocus?: HTMLElement | null | (() => HTMLElement | null);
}

export function BottomSheet({ open, onOpenChange, header, children, slot, bodyClassName, full, onFullChange, onEscapeKeyDown, returnFocus }: BottomSheetProps) {
  const [ownSnap, setOwnSnap] = useState<number | string | null>(BOTTOM_SHEET_SNAP_POINTS[0]);
  const controlled = full !== undefined;
  const snap = controlled ? BOTTOM_SHEET_SNAP_POINTS[full ? 1 : 0] : ownSnap;
  const setSnap = (next: number | string | null) => {
    if (controlled) onFullChange?.(next === BOTTOM_SHEET_SNAP_POINTS[1]);
    else setOwnSnap(next);
  };
  // Every opening starts at half, however it was left: reset when `open` turns
  // true, during render, rather than in an effect that would paint a frame at
  // the old height first.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && !controlled) setOwnSnap(BOTTOM_SHEET_SNAP_POINTS[0]);
  }
  const expanded = snap === BOTTOM_SHEET_SNAP_POINTS[1];

  // At half the content cannot scroll, so whatever was scrolled to up at full
  // height would hide its top with no way back but pulling up again.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [expanded, open]);

  // Closed, focus goes back to what it was opened from at once, not when its
  // slide out ends: by then a tap may have put it somewhere else. Closing
  // can also take the sheet away with what held it (the strip changing its
  // shape as it closes): gone while open, it gives focus back all the same,
  // to what is on the page by then.
  const wasOpenRef = useRef(open);
  const returnFocusRef = useRef(returnFocus);
  useEffect(() => {
    returnFocusRef.current = returnFocus;
    if (wasOpenRef.current && !open) giveFocusTo(returnFocus);
    wasOpenRef.current = open;
  }, [open, returnFocus]);
  useEffect(() => () => {
    if (wasOpenRef.current) giveFocusTo(returnFocusRef.current);
  }, []);

  // Where the current drag started, to judge how far down it was released.
  const dragStartY = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={BOTTOM_SHEET_SNAP_POINTS}
      activeSnapPoint={snap}
      setActiveSnapPoint={setSnap}
      fadeFromIndex={0}
      onRelease={(event) => {
        const start = dragStartY.current;
        dragStartY.current = null;
        if (start === null) return;
        const showing = (expanded ? 1 : BOTTOM_SHEET_SNAP_POINTS[0]) - (event.clientY - start) / window.innerHeight;
        if (showing < BOTTOM_SHEET_CLOSE_BELOW) onOpenChange(false);
      }}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Drawer.Content
          data-slot={slot}
          data-expanded={expanded ? "true" : "false"}
          ref={contentRef}
          aria-describedby={undefined}
          onPointerDownCapture={(event) => { dragStartY.current = event.clientY; }}
          onEscapeKeyDown={onEscapeKeyDown}
          // Focus goes to the sheet itself, which names it to a screen reader.
          // Not vaul's default, which leaves it on the trigger the dialog now
          // hides; and not Radix's first focusable either, which in the pane
          // switcher is a row in the body, where focus pulls the sheet up.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          // Given back on closing (below); once its slide out ends, focus is
          // not moved again, from wherever it is by then.
          onCloseAutoFocus={(event) => {
            if (returnFocus) event.preventDefault();
          }}
          // Full height, slid down to the resting point: at half, the lower
          // half is below the screen until the sheet is pulled up.
          // The bottom safe area pads the sheet, not its body: callers pad the
          // body's bottom, and on one element theirs replaced the inset.
          className="fixed inset-x-0 bottom-0 z-50 flex h-full max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] flex-col rounded-t-2xl bg-background pb-[env(safe-area-inset-bottom)] outline-none"
        >
          {/* vaul styles its handle from a stylesheet it injects after ours,
              light grey for a light page; `!` keeps it on the theme's tokens. */}
          <Drawer.Handle className="mt-2 mb-1 h-1! w-9! shrink-0 rounded-full! bg-border! opacity-100!" />
          <CloseRequests />
          {header}
          <div
            ref={bodyRef}
            data-slot="bottom-sheet-body"
            // Without a focusable handle, moving focus into the content is how
            // a keyboard or switch user reaches what is below the fold. Only
            // focus the browser would draw a ring for: a tap focuses too, and
            // tapping a row must not throw the sheet to full height.
            onFocusCapture={(event) => {
              if (!expanded && (event.target as Element).matches?.(":focus-visible")) {
                setSnap(BOTTOM_SHEET_SNAP_POINTS[1]);
              }
            }}
            className={cn("min-h-0 flex-1", expanded ? "overflow-y-auto" : "overflow-hidden", bodyClassName)}
          >
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** Focus to `target` (asked now, if a function), if it is on the page. */
function giveFocusTo(target: BottomSheetProps["returnFocus"]): void {
  const element = typeof target === "function" ? target() : target;
  if (element?.isConnected) element.focus();
}

export function BottomSheetTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <Drawer.Title className={cn("font-semibold text-foreground", className)}>{children}</Drawer.Title>;
}

export const BottomSheetClose = Drawer.Close;
