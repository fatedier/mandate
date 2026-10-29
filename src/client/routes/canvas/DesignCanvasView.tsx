import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CanvasShownContext } from "./canvas-shown";
import { useGesture } from "@use-gesture/react";
import { cn } from "@/lib/utils";
import type { DesignNote, DesignSnapshot } from "@shared/api-contracts";
import { readCanvasFrameMessage } from "./canvas-bridge";
import { DesignArtboardFrame } from "./DesignArtboardFrame";
import { DESIGN_FOCUS_PADDING, TITLE_LINE_HEIGHT, focusedLayout, noteFontSize, noteSize, titleMaxWidth, wheelPixels } from "./design-camera";
import type { DesignViewer } from "./use-design-viewer";

const OPEN_LAYERS = '[role="menu"][data-state="open"], [role="listbox"][data-state="open"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/** Whether a menu or a dialog is open OVER `view`: later in the document, as
 *  a layer opened after it is. Not the dialog the view is in (the canvas
 *  modal), and not one underneath it (a phone's worker sheet, open in the
 *  document before the canvas): neither is there to take Esc first. */
function layerOpenOver(view: Element | null): boolean {
  return [...document.querySelectorAll(OPEN_LAYERS)].some((layer) =>
    view === null || (!layer.contains(view) && (view.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0));
}

const NOTE_FILLS: Record<string, string> = {
  gray: "#e7e5e4", red: "#fecaca", orange: "#fed7aa", yellow: "#fdf1b8", green: "#bbf7d0",
  teal: "#99f6e4", blue: "#bfdbfe", purple: "#ddd6fe", pink: "#fbcfe8"
};

interface DesignCanvasViewProps {
  canvasId: string;
  design: DesignSnapshot;
  /** The content revision: a new one reloads the frames (a support file may
   *  have changed while every page stayed the same); the view keeps its place. */
  revision: number;
  viewer: DesignViewer;
}

/** A design canvas: the canvas view, or one artboard focused. */
export function DesignCanvasView(props: DesignCanvasViewProps) {
  const { viewer } = props;
  // The canvas stays mounted (hidden) under the focused view, so going back
  // does not reload its artboards.
  return (
    <>
      <CanvasStage {...props} hidden={Boolean(viewer.focused)} />
      {viewer.focused && <FocusedArtboard {...props} />}
    </>
  );
}

function CanvasStage({ canvasId, design, revision, viewer, hidden }: DesignCanvasViewProps & { hidden: boolean }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef(viewer);
  useLayoutEffect(() => { viewerRef.current = viewer; });
  const paths = design.index.boards.map((b) => b.path);

  /** A pointer pinch happened since the current press began (cleared by the
   *  next first finger or mouse press; the library may report a lift twice). */
  const pinched = useRef(false);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const press = (event: PointerEvent) => { if (event.isPrimary) pinched.current = false; };
    stage.addEventListener("pointerdown", press, { capture: true, passive: true });
    return () => stage.removeEventListener("pointerdown", press, { capture: true });
  }, []);
  /** A client point in the stage's own coordinates. */
  const local = (x: number, y: number): [number, number] => {
    const rect = stageRef.current?.getBoundingClientRect();
    return [x - (rect?.left ?? 0), y - (rect?.top ?? 0)];
  };

  // The gestures are @use-gesture's (pointer capture, taps, several fingers,
  // Safari's gesture events): a drag pans and a tap focuses a board; two
  // fingers, a trackpad pinch or Ctrl/⌘+wheel zoom around their point; a
  // wheel pans.
  useGesture({
    onDrag: ({ first, tap, pinching, cancel, delta: [dx, dy], event }) => {
      const target = event.target as Element;
      // One finger on a sticky note with more to show scrolls the note.
      const note = first ? target.closest<HTMLElement>('[data-kind="sticky"]') : null;
      if (pinching || (note && (event as PointerEvent).pointerType !== "mouse" && note.scrollHeight > note.clientHeight + 1)) {
        cancel();
        return;
      }
      if (tap) {
        // A finger that stayed still through a pinch is no tap when it lifts.
        if (pinched.current) return;
        // A button's tap is its own click; a board's focuses it. A press the
        // browser cancelled is no tap.
        if (event.type === "pointercancel" || target.closest("button")) return;
        const board = target.closest("[data-board]")?.getAttribute("data-board");
        if (board) viewerRef.current.focus(board);
        return;
      }
      if (dx || dy) viewerRef.current.panBy(dx, dy);
    },
    onPinch: ({ first, last, da: [distance], origin: [ox, oy], event, memo }) => {
      const [px, py] = local(ox, oy);
      if (event.type === "wheel") {
        // Ctrl/⌘+wheel: a mouse notch steps the ladder, a trackpad scales.
        // The call after the wheel stops repeats the last event: skip it.
        const wheel = event as WheelEvent;
        if (!last) viewerRef.current.zoomWheel(px, py, wheelPixels(wheel.deltaY, wheel.deltaMode));
        return memo;
      }
      if (first && (event.type.startsWith("pointer") || event.type.startsWith("touch"))) pinched.current = true;
      // Fingers (or Safari's gesture scale): carried with their midpoint,
      // scaled by their distance since the last step.
      const previous = (first || !memo ? { distance, ox, oy } : memo) as { distance: number; ox: number; oy: number };
      if (ox !== previous.ox || oy !== previous.oy) viewerRef.current.panBy(ox - previous.ox, oy - previous.oy);
      if (previous.distance > 0 && distance !== previous.distance) viewerRef.current.zoomBy(px, py, distance / previous.distance);
      return { distance, ox, oy };
    },
    onWheel: ({ event, last }) => {
      // A Ctrl/⌘+wheel is the pinch's; the call after the wheel stops
      // repeats the last event.
      if (last || event.ctrlKey || event.metaKey) return;
      // A sticky note with more to show scrolls itself.
      const note = (event.target as Element).closest<HTMLElement>('[data-kind="sticky"]');
      if (note && canScroll(note, event.deltaY)) return;
      event.preventDefault();
      viewerRef.current.panBy(-wheelPixels(event.deltaX, event.deltaMode), -wheelPixels(event.deltaY, event.deltaMode));
    }
  }, {
    target: stageRef,
    eventOptions: { passive: false },
    drag: { filterTaps: true },
    pinch: { modifierKey: ["ctrlKey", "metaKey"] }
  });

  const { camera } = viewer;
  return (
    <div
      ref={stageRef}
      data-slot="design-stage"
      className={cn("relative h-full w-full cursor-grab touch-none select-none overflow-hidden bg-panel", hidden && "invisible")}
      inert={hidden}
      aria-hidden={hidden || undefined}
      style={{ backgroundImage: "radial-gradient(color-mix(in oklab, var(--foreground) 8%, transparent) 1px, transparent 1px)", backgroundSize: "20px 20px" }}
    >
      <div
        data-slot="design-world"
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})` }}
      >
        {design.index.notes.filter((note) => note.page === viewer.canvasPage).map((note) => <Note key={note.id} note={note} />)}
        {design.index.boards.filter((board) => board.page === viewer.canvasPage).map((board) => {
          const name = board.title ?? board.path;
          return (
            <div key={board.path} data-board={board.path} className="absolute" style={{ left: `${board.x}px`, top: `${board.y}px`, width: `${board.w}px`, height: `${board.h}px` }}>
              <div
                data-slot="name-strip"
                className="absolute bottom-full left-0 flex origin-bottom-left items-center gap-1.5 whitespace-nowrap pb-2 text-xs text-muted-foreground"
                // Counter-scaled to stay readable; never wider than its board on screen.
                style={{ transform: `scale(${1 / camera.z})`, maxWidth: `${board.w * camera.z}px` }}
              >
                {board.interactive && (
                  <button type="button" aria-label={`Try ${name}`} onClick={() => viewer.focus(board.path)} className="grid size-5 place-items-center rounded-sm bg-primary text-primary-foreground">
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 1l7 4-7 4z" fill="currentColor" /></svg>
                  </button>
                )}
                <button type="button" onClick={() => viewer.focus(board.path)} className="min-w-0 truncate hover:text-foreground">{name}</button>
              </div>
              <div className="h-full w-full cursor-pointer overflow-hidden shadow-md" style={{ borderRadius: `${board.radius}px` }}>
                <DesignArtboardFrame key={revision} canvasId={canvasId} board={board} html={design.artboards[board.path] ?? ""} boards={paths} interactive={false} width={`${board.w}px`} height={`${board.h}px`} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Note({ note }: { note: DesignNote }) {
  if (note.kind === "title1") return <TitleNote note={note} />;
  const { w, h } = noteSize(note);
  return (
    <div
      data-slot="design-note"
      data-kind="sticky"
      className="absolute rounded-sm p-4 shadow-md"
      style={{
        left: `${note.x}px`, top: `${note.y}px`, width: `${w}px`, maxHeight: `${h}px`,
        background: NOTE_FILLS[note.fill ?? "yellow"] ?? NOTE_FILLS.yellow, color: note.color ?? "#3b3310",
        fontSize: `${noteFontSize(note)}px`, fontWeight: note.bold ? 700 : undefined, fontStyle: note.italic ? "italic" : undefined, lineHeight: 1.4,
        // Taller text scrolls; a long word wraps rather than scrolling sideways.
        overflowX: "hidden", overflowY: "auto", overflowWrap: "anywhere", whiteSpace: "pre-wrap",
        touchAction: "pan-y"
      }}
    >
      {note.text}
    </div>
  );
}

/** A row title: one bold line that, longer than its maxW, shrinks to fit it.
 *  Measured at full size once laid out. */
function TitleNote({ note }: { note: DesignNote }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const font = noteFontSize(note);
  const maxW = titleMaxWidth(note);
  const key = `${note.text}\n${maxW ?? ""}\n${font}\n${note.italic}`;
  const [fitted, setFitted] = useState<{ key: string; size: number } | null>(null);
  const size = fitted?.key === key ? fitted.size : font;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !maxW) return;
    const shown = element.style.fontSize;
    element.style.fontSize = `${font}px`;
    const width = element.scrollWidth;
    element.style.fontSize = shown;
    const next = width > maxW ? (font * maxW) / width : font;
    setFitted((previous) => (previous?.key === key && previous.size === next ? previous : { key, size: next }));
  }, [key, font, maxW]);
  return (
    <div
      ref={ref}
      data-slot="design-note"
      data-kind="title1"
      className="absolute overflow-hidden whitespace-nowrap text-foreground"
      style={{
        left: `${note.x}px`, top: `${note.y}px`, maxWidth: maxW ? `${maxW}px` : undefined,
        fontSize: `${size}px`, fontWeight: 700, fontStyle: note.italic ? "italic" : undefined,
        lineHeight: TITLE_LINE_HEIGHT, color: note.color ?? undefined
      }}
    >
      {note.text}
    </div>
  );
}

function FocusedArtboard({ canvasId, design, revision, viewer }: DesignCanvasViewProps) {
  const board = viewer.focused!;
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef(viewer);
  useLayoutEffect(() => { viewerRef.current = viewer; });
  // A canvas tab a panel keeps drawn behind another hears no keys.
  const shown = useContext(CanvasShownContext);
  const shownRef = useRef(shown);
  useLayoutEffect(() => { shownRef.current = shown; });
  const layout = focusedLayout(board, viewer.stage, viewer.focusZoom);

  // The focused view has no zoom gesture (Fit / 100% is the menu's), and a
  // desktop browser must not take one: Chrome keeps a page zoom per site. A
  // phone's pinch is left to the browser, which magnifies the screen.
  useEffect(() => {
    const focus = focusRef.current;
    if (!focus) return;
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const wheel = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    const gesture = (event: Event) => { if (!coarse) event.preventDefault(); };
    focus.addEventListener("wheel", wheel, { passive: false });
    focus.addEventListener("gesturestart", gesture);
    focus.addEventListener("gesturechange", gesture);
    return () => {
      focus.removeEventListener("wheel", wheel);
      focus.removeEventListener("gesturestart", gesture);
      focus.removeEventListener("gesturechange", gesture);
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const message = readCanvasFrameMessage(event.data, canvasId);
      if (message?.type === "go" && design.artboards[message.path] !== undefined) viewerRef.current.focus(message.path);
      else if (message?.type === "key" && message.key === "Escape") viewerRef.current.unfocus();
      else if (message?.type === "key" && message.key === "Enter" && (message.metaKey || message.ctrlKey) && message.shiftKey && shownRef.current) {
        // ⌘⇧Enter does not bubble out of the frame: heard as the page's own,
        // for the panel's Hide chat (as the report viewer passes it on).
        frame.dispatchEvent(new KeyboardEvent("keydown", {
          key: message.key, metaKey: message.metaKey, ctrlKey: message.ctrlKey,
          shiftKey: message.shiftKey, bubbles: true, cancelable: true
        }));
      }
    };
    // Esc leaves the focused view before anything else hears it (the canvas
    // modal closes on Esc), unless an open menu or dialog (the delete
    // question) is there to close first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !shownRef.current) return;
      // Beside a chat, Esc pressed there (renaming the thread, the composer)
      // is the chat's: only one pressed in the canvas, or with nothing in
      // particular focused, or on what holds it (the modal), leaves the view.
      const root = focusRef.current?.closest('[data-slot="canvas-view"]') ?? null;
      const target = event.target instanceof Node ? event.target : null;
      if (root && target && !root.contains(target) && !target.contains(root)) return;
      // A held key's repeats are not a second press (the first may have
      // closed a menu); an open menu or dialog takes Esc first.
      if (event.repeat) return;
      if (layerOpenOver(focusRef.current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      viewerRef.current.unfocus();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [frame, canvasId, design]);

  return (
    <div ref={focusRef} data-slot="design-focus" className="absolute inset-0 grid place-items-center overflow-auto bg-panel" style={{ padding: board.expand === "fill" ? 0 : DESIGN_FOCUS_PADDING }}>
      <div className="overflow-hidden shadow-md" style={{ width: `${layout.width * layout.scale}px`, height: `${layout.height * layout.scale}px`, borderRadius: `${board.radius * layout.scale}px` }}>
        <div style={{ width: `${layout.width}px`, height: `${layout.height}px`, transform: layout.scale === 1 ? undefined : `scale(${layout.scale})`, transformOrigin: "0 0" }}>
          <DesignArtboardFrame
            key={`${board.path}:${revision}`}
            canvasId={canvasId}
            board={board}
            html={design.artboards[board.path] ?? ""}
            boards={design.index.boards.map((b) => b.path)}
            interactive
            width={`${layout.width}px`}
            height={`${layout.height}px`}
            frameRef={setFrame}
          />
        </div>
      </div>
    </div>
  );
}

/** Whether a note can scroll further in the wheel's direction. */
function canScroll(note: HTMLElement, deltaY: number): boolean {
  if (note.scrollHeight <= note.clientHeight + 1) return false;
  if (deltaY > 0) return note.scrollTop + note.clientHeight < note.scrollHeight - 1;
  return deltaY < 0 && note.scrollTop > 0;
}
