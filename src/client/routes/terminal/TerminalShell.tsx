import { forwardRef, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { ArrowDown, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SelectionHandleGeometry, SelectionHandleKind } from "./terminal-helpers";

interface TerminalShellProps {
  isMobile: boolean;
  firstPaintReady: boolean;
  scrolledBack: boolean;
  hasSelection: boolean;
  keysVisible: boolean;
  selectionHandles: SelectionHandleGeometry | null;
  /** Where the Copy button sits, by the selection; null while none of it is
   *  in sight or a pointer is making it (measured there, unseen). */
  copyPlace: { left: number; top: number } | null;
  copyButtonRef: RefObject<HTMLButtonElement | null>;
  /** Where the Copy button stood when it copied, for a moment after: it says
   *  Copied there. Null otherwise, and while text is selected again. */
  copiedPlace: { left: number; top: number } | null;
  terminalShellStyle: React.CSSProperties | undefined;
  terminalViewportRef: RefObject<HTMLDivElement | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  onScrollToBottom: () => void;
  onCopySelection: () => void;
  onBeginSelectionHandleDrag: (
    kind: SelectionHandleKind,
    event: ReactPointerEvent<HTMLButtonElement>
  ) => void;
}

/** The non-scrolling shell that wraps the xterm viewport, plus the floating
 *  overlay buttons (scroll-to-bottom; copy, by the selection) and the mobile
 *  selection-handle pucks. Padding lives on the viewport child so xterm's
 *  FitAddon can read the parent's width cleanly. */
export const TerminalShell = forwardRef<HTMLDivElement, TerminalShellProps>(function TerminalShell(
  {
    isMobile,
    firstPaintReady,
    scrolledBack,
    hasSelection,
    keysVisible,
    selectionHandles,
    copyPlace,
    copyButtonRef,
    copiedPlace,
    terminalShellStyle,
    terminalViewportRef,
    terminalContainerRef,
    onScrollToBottom,
    onCopySelection,
    onBeginSelectionHandleDrag
  },
  ref
) {
  // The Copied mark is wider than the Copy button whose place it takes: it
  // is kept inside the terminal as it is now (a key bar shown since takes
  // its foot), measured before it is painted: again when either changes.
  const copiedRef = useRef<HTMLSpanElement | null>(null);
  const [copiedFit, setCopiedFit] = useState<{ of: { left: number; top: number }; left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const mark = copiedRef.current;
    const box = mark?.offsetParent;
    if (!mark || !(box instanceof HTMLElement) || !copiedPlace) return;
    const left = Math.max(0, Math.min(copiedPlace.left, box.clientWidth - mark.offsetWidth));
    const top = Math.max(0, Math.min(copiedPlace.top, box.clientHeight - mark.offsetHeight));
    setCopiedFit((prev) => (prev && prev.of === copiedPlace && prev.left === left && prev.top === top ? prev : { of: copiedPlace, left, top }));
  }, [copiedPlace, keysVisible]);
  const copiedAt = copiedPlace && copiedFit?.of === copiedPlace ? copiedFit : copiedPlace;
  return (
    <div
      ref={ref}
      className="relative flex-1 min-h-0 bg-terminal-bg"
      style={terminalShellStyle}
    >
      <div
        ref={terminalViewportRef}
        className={cn(
          "absolute inset-0",
          isMobile ? "px-2 py-1 overflow-auto overscroll-contain" : "px-4 py-2 overflow-hidden"
        )}
      >
        {/* xterm renders into this inner div. FitAddon reads its parent's
            getComputedStyle width to size the grid; if we put padding on
            the same div terminal.open() attaches to, FitAddon doesn't
            subtract that padding and xterm overflows. Keeping padding on
            the outer wrapper and the FitAddon container flush works. */}
        <div
          ref={terminalContainerRef}
          className={cn("h-full w-full", !firstPaintReady && "opacity-0")}
        />
      </div>
      {!firstPaintReady && (
        <div className="absolute inset-0 z-30 bg-terminal-bg pointer-events-none" />
      )}
      {scrolledBack && (
        <Button
          variant="outline"
          size="icon"
          className={cn(
            "absolute left-1/2 z-20 h-9 w-9 -translate-x-1/2 rounded-full shadow-md bg-panel",
            // Above the key bar: 83px tall, 107px with touch-sized keys.
            isMobile && keysVisible ? "bottom-20 pointer-coarse:bottom-28" : "bottom-6"
          )}
          aria-label="Scroll to bottom"
          onClick={onScrollToBottom}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      )}
      {hasSelection && (
        <Button
          ref={copyButtonRef}
          variant="outline"
          size="sm"
          // Its colours ease, never its place: it shows where it sits.
          className="absolute z-20 shadow-md bg-panel transition-colors"
          style={copyPlace ? { left: copyPlace.left, top: copyPlace.top } : { left: 0, top: 0, visibility: "hidden" }}
          aria-label="Copy selection"
          onClick={onCopySelection}
        >
          <Copy className="h-4 w-4" />
          Copy
        </Button>
      )}
      {/* The Copy button's own confirmation, as the app's other copy buttons
          give theirs: in its place, not a notice over the page. It takes no
          clicks: a click or a drag there goes to the terminal. A screen
          reader hears it from the status below, there before the copy. */}
      {!hasSelection && copiedAt && (
        // The look's classes on the Button, merged with its own there (a
        // child's are only appended, and lose to the outline's transparency).
        // It shows where it sits, never sliding there (the Button eases all).
        <Button asChild variant="outline" size="sm" className="pointer-events-none absolute z-20 shadow-md bg-panel transition-none animate-in fade-in-0 duration-150">
          <span ref={copiedRef} data-slot="terminal-copied" aria-hidden style={{ left: copiedAt.left, top: copiedAt.top }}>
            <Check className="h-4 w-4 text-phase-done" aria-hidden />
            Copied
          </span>
        </Button>
      )}
      <span data-slot="terminal-copy-status" role="status" className="sr-only">{copiedPlace ? "Copied" : ""}</span>
      {isMobile && selectionHandles?.start.visible && (
        <button
          type="button"
          aria-label="Drag selection start"
          className="absolute z-50 h-11 w-11 -translate-x-1/2 -translate-y-0.5 touch-none rounded-full bg-transparent p-0 transition-transform active:scale-95"
          style={{ left: selectionHandles.start.left, top: selectionHandles.start.top }}
          onPointerDown={(event) => onBeginSelectionHandleDrag("start", event)}
        >
          <span className="absolute left-1/2 top-2 h-[18px] w-3 -translate-x-1/2 rounded-full bg-primary/90 shadow-[0_2px_10px_rgba(0,0,0,0.32)] ring-1 ring-terminal-bg/80" />
        </button>
      )}
      {isMobile && selectionHandles?.end.visible && (
        <button
          type="button"
          aria-label="Drag selection end"
          className="absolute z-50 h-11 w-11 -translate-x-1/2 -translate-y-0.5 touch-none rounded-full bg-transparent p-0 transition-transform active:scale-95"
          style={{ left: selectionHandles.end.left, top: selectionHandles.end.top }}
          onPointerDown={(event) => onBeginSelectionHandleDrag("end", event)}
        >
          <span className="absolute left-1/2 top-2 h-[18px] w-3 -translate-x-1/2 rounded-full bg-primary/90 shadow-[0_2px_10px_rgba(0,0,0,0.32)] ring-1 ring-terminal-bg/80" />
        </button>
      )}
    </div>
  );
});
