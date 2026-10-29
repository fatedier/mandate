import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesignBoard, DesignPage, DesignSnapshot } from "@shared/api-contracts";
import { contentBounds, designWheelZoom, fitCamera, stepDesignZoom, zoomCameraAt, type Camera, type Size } from "./design-camera";

export type FocusZoom = "fit" | "actual";

export interface DesignViewer {
  pages: DesignPage[];
  page: string;
  setPage(id: string): void;
  boards: DesignBoard[];
  notes: DesignSnapshot["index"]["notes"];
  camera: Camera;
  fitted: boolean;
  fitAll(): void;
  zoomTo(z: number): void;
  step(direction: 1 | -1): void;
  zoomAt(px: number, py: number, z: number): void;
  /** Zoom by a factor of the camera last set, so gesture steps that arrive
   *  before a render all count. */
  zoomBy(px: number, py: number, factor: number): void;
  /** Ctrl+wheel by a delta in pixels, from the camera last set. */
  zoomWheel(px: number, py: number, pixels: number): void;
  panBy(dx: number, dy: number): void;
  focused: DesignBoard | null;
  focusIndex: number;
  focusZoom: FocusZoom;
  setFocusZoom(zoom: FocusZoom): void;
  focus(path: string): void;
  unfocus(): void;
  next(): void;
  prev(): void;
  stage: Size;
  /** The page the canvas view shows: while an artboard is focused, the one
   *  going back returns to (a prototype link may have left it). */
  canvasPage: string;
}

interface ViewState {
  canvasId: string;
  /** False until the design has arrived and its launch has been applied. */
  started: boolean;
  page: string;
  camera: Camera;
  fitted: boolean;
  focused: string | null;
  focusZoom: FocusZoom;
  /** The canvas view to return to from the focused view. */
  back: { page: string; camera: Camera; fitted: boolean } | null;
}

const EMPTY_PAGES: DesignPage[] = [{ id: "main", name: "" }];
const blank = (canvasId: string): ViewState =>
  ({ canvasId, started: false, page: "", camera: { x: 0, y: 0, z: 1 }, fitted: true, focused: null, focusZoom: "fit", back: null });

/**
 * A design canvas's view: page, camera and focused artboard. The
 * camera is derived while "fitted" (Fit all recomputed from the stage), so a
 * resize refits without an effect. A new canvas id starts over; a republish
 * of the same canvas keeps the page, the camera and a focused board that
 * still exists.
 */
export function useDesignViewer(canvasId: string, design: DesignSnapshot | null, stage: Size): DesignViewer {
  const [state, setState] = useState<ViewState>(() => blank(canvasId));
  const index = design?.index ?? null;
  const pages = index?.pages ?? EMPTY_PAGES;

  // Start over for another canvas; apply the launch once the design arrives
  // (adjusting state while rendering, React's pattern for a reset on a prop).
  let current = state;
  if (current.canvasId !== canvasId) current = blank(canvasId);
  if (!current.started && index) {
    const launch = index.launch;
    if (launch.view === "focused") {
      const path = launch.path;
      current = { ...current, started: true, focused: path, page: index.boards.find((b) => b.path === path)?.page ?? pages[0]!.id, back: null };
    } else {
      current = { ...current, started: true, page: launch.page };
    }
  }
  if (index) {
    // A republish: a page or a focused board that is gone falls back.
    if (!pages.some((p) => p.id === current.page)) current = { ...current, page: pages[0]!.id, fitted: true };
    // A focused board that is gone drops the focus; one moved to another page
    // takes the view there.
    const focusedBoard = current.focused ? index.boards.find((b) => b.path === current.focused) : undefined;
    if (current.focused && !focusedBoard) {
      // Back to the canvas view it was opened from, as leaving would.
      const back = current.back;
      current = { ...current, focused: null, back: null, page: back?.page ?? current.page, camera: back?.camera ?? current.camera, fitted: back ? back.fitted : true };
    }
    else if (focusedBoard && focusedBoard.page !== current.page) current = { ...current, page: focusedBoard.page };
  }
  if (current !== state) setState(current);

  const boards = useMemo(() => (index?.boards ?? []).filter((b) => b.page === current.page), [index, current.page]);
  const notes = useMemo(() => (index?.notes ?? []).filter((n) => n.page === current.page), [index, current.page]);
  const camera = current.fitted ? fitCamera(contentBounds(boards, notes), stage) : current.camera;
  const focused = current.focused ? index?.boards.find((b) => b.path === current.focused) ?? null : null;
  const focusBoards = focused ? (index?.boards ?? []).filter((b) => b.page === focused.page) : [];
  const focusIndex = focused ? focusBoards.findIndex((b) => b.path === focused.path) : -1;

  // Gesture steps can arrive faster than React renders: they start from the
  // camera last set, not from the last committed one.
  const live = useRef({ camera, stage, index, focusBoards, focused, current });
  useLayoutEffect(() => { live.current = { camera, stage, index, focusBoards, focused, current }; });

  const setCamera = useCallback((next: Camera) => {
    live.current = { ...live.current, camera: next };
    setState((s) => ({ ...s, camera: next, fitted: false }));
  }, []);
  const zoomAt = useCallback((px: number, py: number, z: number) => setCamera(zoomCameraAt(live.current.camera, px, py, z)), [setCamera]);
  const zoomTo = useCallback((z: number) => {
    const { stage: size } = live.current;
    zoomAt(size.width / 2, size.height / 2, z);
  }, [zoomAt]);
  const focus = useCallback((path: string) => {
    const target = live.current.index?.boards.find((b) => b.path === path);
    if (!target) return;
    setState((s) => ({
      ...s,
      focused: path,
      page: target.page,
      focusZoom: "fit",
      back: s.focused ? s.back : { page: s.page, camera: live.current.camera, fitted: s.fitted }
    }));
  }, []);

  return {
    pages,
    page: current.page,
    setPage: useCallback((id: string) => setState((s) => ({ ...s, page: id, fitted: true, focused: null, back: null })), []),
    boards,
    notes,
    camera,
    fitted: current.fitted,
    fitAll: useCallback(() => setState((s) => ({ ...s, fitted: true })), []),
    zoomTo,
    step: useCallback((direction: 1 | -1) => zoomTo(stepDesignZoom(live.current.camera.z, direction)), [zoomTo]),
    zoomAt,
    zoomBy: useCallback((px: number, py: number, factor: number) => zoomAt(px, py, live.current.camera.z * factor), [zoomAt]),
    zoomWheel: useCallback((px: number, py: number, pixels: number) => zoomAt(px, py, designWheelZoom(live.current.camera.z, pixels)), [zoomAt]),
    panBy: useCallback((dx: number, dy: number) => {
      const { camera: cam } = live.current;
      setCamera({ ...cam, x: cam.x + dx, y: cam.y + dy });
    }, [setCamera]),
    focused,
    focusIndex,
    focusZoom: current.focusZoom,
    setFocusZoom: useCallback((zoom: FocusZoom) => setState((s) => ({ ...s, focusZoom: zoom })), []),
    focus,
    unfocus: useCallback(() => setState((s) => {
      if (!s.focused) return s;
      // Back to the canvas view the reader left, also when a
      // prototype link crossed pages.
      const back = s.back;
      return { ...s, focused: null, back: null, page: back?.page ?? s.page, camera: back?.camera ?? s.camera, fitted: back ? back.fitted : true };
    }), []),
    next: useCallback(() => {
      const { focusBoards: list, focused: at } = live.current;
      const i = at ? list.findIndex((b) => b.path === at.path) : -1;
      if (i >= 0 && i < list.length - 1) focus(list[i + 1]!.path);
    }, [focus]),
    prev: useCallback(() => {
      const { focusBoards: list, focused: at } = live.current;
      const i = at ? list.findIndex((b) => b.path === at.path) : -1;
      if (i > 0) focus(list[i - 1]!.path);
    }, [focus]),
    stage,
    canvasPage: current.focused && current.back ? current.back.page : current.page
  };
}

/** Whether the design has pages worth a menu: more than one, or a named one. */
export function designShowsPages(viewer: DesignViewer): boolean {
  return viewer.pages.length > 1 || Boolean(viewer.pages[0]?.name);
}
