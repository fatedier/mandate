import { useMemo, type CSSProperties } from "react";
import type { DesignBoard } from "@shared/api-contracts";
import { artboardAssetsUrl, buildCanvasSrcDoc, canvasAssetsUrl } from "./canvas-srcdoc";

interface DesignArtboardFrameProps {
  canvasId: string;
  board: DesignBoard;
  html: string;
  /** Every board's path, for prototype links. */
  boards: string[];
  /** The focused view: the page takes pointer events. On the canvas it does
   *  not, so a drag pans and a click focuses. */
  interactive: boolean;
  width: string;
  height: string;
  frameRef?: (element: HTMLIFrameElement | null) => void;
}

/** One artboard: the report's skeleton, CSP and runtime, but no
 *  theme stamp. The frame's `color-scheme: light` sets its own ground; it does
 *  NOT pin the page's prefers-color-scheme (Chromium follows the OS, measured),
 *  so an artboard is one look by convention: the skill says so and publish
 *  warns. On the canvas the frame is inert: a
 *  click focuses it, and Tab never enters it. */
export function DesignArtboardFrame({ canvasId, board, html, boards, interactive, width, height, frameRef }: DesignArtboardFrameProps) {
  const boardList = boards.join("\n");
  const srcDoc = useMemo(() => buildCanvasSrcDoc(html, {
    canvasId,
    theme: null,
    assetsBaseUrl: artboardAssetsUrl(canvasId, board.path),
    folderUrl: canvasAssetsUrl(canvasId),
    artboard: { path: board.path, boards: boardList.split("\n") }
  }), [canvasId, board.path, html, boardList]);
  const style: CSSProperties = {
    width,
    height,
    border: "none",
    display: "block",
    colorScheme: "light",
    pointerEvents: interactive ? "auto" : "none",
    borderRadius: `${board.radius}px`
  };
  return (
    <iframe
      ref={frameRef}
      title={board.title ?? board.path}
      data-artboard={board.path}
      inert={!interactive}
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      allow="clipboard-write *; fullscreen *"
      style={style}
    />
  );
}
