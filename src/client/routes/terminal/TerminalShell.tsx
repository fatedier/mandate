import { forwardRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { ArrowDown, Copy } from "lucide-react";
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
 *  overlay buttons (scroll-to-bottom, copy) and the mobile selection-handle
 *  pucks. Padding lives on the viewport child so xterm's FitAddon can read
 *  the parent's width cleanly. */
export const TerminalShell = forwardRef<HTMLDivElement, TerminalShellProps>(function TerminalShell(
  {
    isMobile,
    firstPaintReady,
    scrolledBack,
    hasSelection,
    keysVisible,
    selectionHandles,
    terminalShellStyle,
    terminalViewportRef,
    terminalContainerRef,
    onScrollToBottom,
    onCopySelection,
    onBeginSelectionHandleDrag
  },
  ref
) {
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
            "absolute left-1/2 z-20 h-9 w-9 -translate-x-1/2 rounded-full shadow-md bg-card/95 backdrop-blur",
            isMobile && keysVisible ? "bottom-20" : "bottom-6"
          )}
          aria-label="Scroll to bottom"
          onClick={onScrollToBottom}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      )}
      {hasSelection && (
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "absolute z-20 shadow-md bg-card/95 backdrop-blur",
            isMobile ? "right-3 top-3" : "right-6 top-6"
          )}
          aria-label="Copy selection"
          onClick={onCopySelection}
        >
          <Copy className="h-4 w-4" />
          Copy
        </Button>
      )}
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
