import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { shouldIgnoreGlobalEscape } from "@/lib/keyboard-targets";
import { getSidePanelWidth, SIDE_PANEL_WIDTH_MIN, SPLIT_ROW_MIN_WIDTH } from "@/lib/pane-layout";

/** How the side moves as the layout changes, so it never pops in or out: in
 *  a wide row the divider slides (the side's width, "push"), in a narrow one
 *  the side slides over the chat and back, as a page opened on a phone does.
 *  The easing is the house entrance's (globals.css). */
const PUSH = { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" };
const SLIDE = { duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/** What the row shows: the chat alone, both side by side, or the side alone. */
type Layout = "chat" | "split" | "side";
type Motion =
  | { kind: "push"; from: number; to: number; then: Layout }
  | { kind: "slide"; enter: boolean; then: Layout };

/** Motion unless the person asked their system for less. */
function motionWanted(): boolean {
  return typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface LayoutState { target: Layout; narrow: boolean; shown: Layout; motion: Motion | null }

/** The next layout state for a new target or a new narrow flag: the side
 *  moves when the layout changes in place, and it all takes effect at once
 *  when it was already moving, the row crossed the narrow edge, the row is
 *  unmeasured, or less motion is asked for. */
function planLayout(
  prev: LayoutState,
  next: { target: Layout; narrow: boolean; measured: boolean; width: number; rowWidth: number }
): LayoutState {
  const { target, narrow } = next;
  const now = { target, narrow, shown: target, motion: null };
  if (target === prev.shown && !prev.motion) return now;
  if (prev.motion || prev.narrow !== narrow || !next.measured || !motionWanted()) return now;
  if (narrow) {
    const swap = (prev.shown === "chat" && target === "side") || (prev.shown === "side" && target === "chat");
    return swap ? { target, narrow, shown: prev.shown, motion: { kind: "slide", enter: target === "side", then: target } } : now;
  }
  const sideWidth = (layout: Layout) => (layout === "chat" ? 0 : layout === "side" ? next.rowWidth : next.width);
  const from = sideWidth(prev.shown);
  const to = sideWidth(target);
  return from === to ? now : { target, narrow, shown: prev.shown, motion: { kind: "push", from, to, then: target } };
}

interface SplitRowProps {
  /** The side is shown (its owner's toggle). */
  open: boolean;
  /** The side has the whole row (its own maximize). */
  maximized: boolean;
  /** In a narrow row, the side in sight. */
  narrowView: "chat" | "side";
  /** The row became narrow, or wide again (and false when it unmounts). */
  onNarrow(narrow: boolean): void;
  onNarrowView(view: "chat" | "side"): void;
  onMaximized(on: boolean): void;
  /** The shortcut brings in a hidden side, in a narrow row. */
  onOpen(): void;
  /** One side at a time whatever the row's width (a phone). */
  alwaysNarrow?: boolean;
  /** The side's share of the row, remembered by the owner. */
  ratio: number;
  onRatio(ratio: number): void;
  slots: { chat: string; side: string };
  labels: { side: string; resize: string; valueSuffix: string };
  chat: ReactNode;
  side: ReactNode;
}

/**
 * The chat and a side pane, side by side. The side can take the whole row
 * (its own maximize); the chat takes it when the side is hidden, so nothing
 * floats over the transcript. The side's share of the row is its owner's to
 * keep. A row narrower than SPLIT_ROW_MIN_WIDTH shows one side at a time,
 * whole (`narrowView`). Esc gives a side that has the row back to the chat;
 * Cmd/Ctrl+Shift+Enter toggles it.
 */
export function SplitRow(props: SplitRowProps) {
  const { open, maximized, narrowView, ratio, onRatio, slots, labels, chat, side, alwaysNarrow = false } = props;
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const width = getSidePanelWidth(rowWidth, ratio);
  // Unmeasured (0) is not narrow: a row that cannot be measured keeps both.
  const narrow = rowWidth > 0 && (alwaysNarrow || rowWidth < SPLIT_ROW_MIN_WIDTH);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Handlers read the owner's latest state, as a store's getState() would.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    const measure = () => setRowWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Before paint, so the owner's toggle never shows the other mode's state.
  // A row that narrows shows the chat, unless the side had the whole row; a
  // row first measured narrow keeps its side, which may be opening.
  const measured = rowWidth > 0;
  const wasNarrow = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    if (!measured) return;
    const p = latest.current;
    if (narrow && wasNarrow.current === false) p.onNarrowView(p.maximized ? "side" : "chat");
    wasNarrow.current = narrow;
    p.onNarrow(narrow);
  }, [narrow, measured]);
  useLayoutEffect(() => () => latest.current.onNarrow(false), []);

  // In a narrow row the side always has the row, so the keys swap it with the
  // chat, and the shortcut brings in a hidden side, as the owner's toggle
  // does: there a hidden side and the chat's turn look the same.
  useEffect(() => {
    if (!open && !narrow) return;
    const onKey = (e: KeyboardEvent) => {
      const p = latest.current;
      const sideHasRow = narrow ? p.open && p.narrowView === "side" : p.maximized;
      const giveBack = () => (narrow ? p.onNarrowView("chat") : p.onMaximized(false));
      if (e.key === "Escape" && sideHasRow && !shouldIgnoreGlobalEscape(e)) {
        giveBack();
      } else if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (sideHasRow) giveBack();
        else if (narrow) {
          p.onOpen();
          p.onNarrowView("side");
        } else p.onMaximized(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, narrow]);

  const resize = (next: number) => {
    if (rowWidth <= 0) return;
    onRatio(getSidePanelWidth(rowWidth, next / rowWidth) / rowWidth);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Some pointer sources reject pointer capture; the drag still ended.
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const sideHidden = !open || (narrow && narrowView === "chat");
  const sideHasRow = !sideHidden && (narrow || maximized);
  const chatHidden = sideHasRow;

  // The layout asked for, and the one on screen: they differ while the side
  // moves from one to the other. Worked out as the props change (during
  // render, React's way of adjusting state to props): a change while it
  // moves, or across the narrow edge, or with less motion asked for, takes
  // effect at once; only a change of layout moves the side, never a resize
  // or a drag.
  const target: Layout = sideHidden ? "chat" : sideHasRow ? "side" : "split";
  const [layoutState, setLayoutState] = useState<LayoutState>({ target, narrow, shown: target, motion: null });
  if (layoutState.target !== target || layoutState.narrow !== narrow) {
    setLayoutState(planLayout(layoutState, { target, narrow, measured, width, rowWidth }));
  }
  const { shown, motion } = layoutState;
  const chatRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);

  // Before paint, so the side never shows where it is going before it goes.
  useLayoutEffect(() => {
    if (!motion) return;
    const side = sideRef.current;
    const chatPane = chatRef.current;
    const end = () => setLayoutState((state) => ({ ...state, shown: motion.then, motion: null }));
    if (!side) {
      const soon = window.setTimeout(end, 0);
      return () => window.clearTimeout(soon);
    }
    const timing = { ...(motion.kind === "push" ? PUSH : SLIDE), fill: "forwards" as const };
    const animations: Animation[] = [];
    if (motion.kind === "push") {
      animations.push(side.animate([{ width: `${motion.from}px` }, { width: `${motion.to}px` }], timing));
    } else {
      const [off, on] = ["translateX(100%)", "translateX(0)"];
      animations.push(side.animate([{ transform: motion.enter ? off : on }, { transform: motion.enter ? on : off }], timing));
      const [still, back] = [{ transform: "translateX(0)", opacity: 1 }, { transform: "translateX(-18%)", opacity: 0.5 }];
      if (chatPane) animations.push(chatPane.animate(motion.enter ? [still, back] : [back, still], timing));
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      end();
    };
    void Promise.all(animations.map((animation) => animation.finished)).then(finish, () => {});
    // An animation the browser never runs still ends.
    const fallback = window.setTimeout(finish, timing.duration + 120);
    return () => {
      done = true;
      window.clearTimeout(fallback);
      for (const animation of animations) animation.cancel();
    };
  }, [motion]);

  const layout = motion ? (motion.kind === "push" ? "split" : "over") : shown;
  // While it pushes, the side's content keeps the width it will end at (or
  // had), so it moves with the edge instead of being laid out every frame;
  // only its width: it keeps the side's height, so a scroller in it keeps
  // its place.
  const bodyWidth = motion?.kind === "push" ? Math.max(motion.from, motion.to) : null;
  return (
    // While the side moves the row clips it: sliding in, it is off the row's
    // edge, and the page around must not scroll sideways for it.
    <div ref={rowRef} className={cn("flex min-h-0 w-full flex-1", layout === "over" && "relative", motion && "overflow-hidden")}>
      <div
        ref={chatRef}
        data-slot={slots.chat}
        inert={chatHidden}
        aria-hidden={chatHidden || undefined}
        className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", layout === "side" && "hidden", motion && "overflow-hidden")}
      >
        {chat}
      </div>
      {layout !== "chat" && (
        <aside
          ref={sideRef}
          aria-label={labels.side}
          data-slot={slots.side}
          inert={sideHidden}
          aria-hidden={sideHidden || undefined}
          style={layout === "split" ? { width: motion?.kind === "push" ? motion.from : width } : undefined}
          className={cn(
            // min-w-0: a strip of many tabs scrolls inside; it never widens the side.
            "relative flex min-h-0 min-w-0 flex-col bg-background",
            // With the row to itself there is no chat to divide it from.
            layout === "side" && "flex-1",
            layout === "split" && "shrink-0 border-l border-border-soft",
            layout === "over" && "absolute inset-0 z-10 border-l border-border-soft",
            motion && "overflow-hidden"
          )}
        >
          {layout === "split" && !motion && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={labels.resize}
              aria-valuemin={Math.round(Math.min(SIDE_PANEL_WIDTH_MIN, rowWidth / 2))}
              aria-valuemax={Math.round(rowWidth - Math.min(SIDE_PANEL_WIDTH_MIN, rowWidth / 2))}
              aria-valuenow={Math.round(width)}
              aria-valuetext={`${Math.round(rowWidth > 0 ? width / rowWidth * 100 : 50)}% ${labels.valueSuffix}`}
              tabIndex={0}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                dragRef.current = { startX: e.clientX, startWidth: width };
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* see endDrag */ }
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
              onPointerMove={(e) => {
                const drag = dragRef.current;
                // Anchored to the right edge: dragging left grows the side.
                if (drag) resize(drag.startWidth + (drag.startX - e.clientX));
              }}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
              onDoubleClick={() => onRatio(0.5)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  resize(width + (event.key === "ArrowLeft" ? 20 : -20));
                } else if (event.key === "Enter" || event.key === "Home") {
                  event.preventDefault();
                  onRatio(0.5);
                }
              }}
              title="Drag to resize · double-click for equal split"
              className="group absolute inset-y-0 left-0 z-[1] flex w-2 cursor-col-resize touch-none select-none items-stretch"
            >
              <div className="w-px bg-transparent transition-colors group-hover:bg-border group-active:bg-border" />
              <span
                aria-hidden
                data-slot="pane-grip"
                className="pointer-events-none absolute left-1/2 top-1/2 h-9 w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-[3px] bg-faint opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100"
              />
            </div>
          )}
          <div
            data-slot="split-side-body"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            style={bodyWidth !== null ? { width: bodyWidth } : undefined}
          >
            {side}
          </div>
        </aside>
      )}
    </div>
  );
}
