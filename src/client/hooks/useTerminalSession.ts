import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { copyTextToClipboard } from "@/lib/clipboard";
import { api } from "@/lib/api-paths";
import { getPaneDisplayCommand } from "@/lib/render";
import type { SnapshotPane } from "@/lib/snapshot-types";
import type { PaneByIdResponse } from "@shared/api-contracts";
import {
  MOBILE_WEB_FIT_WIDTH_COLS,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  isMobileTerminalViewport,
  paneTerminalGeometry,
  terminalBrowserFitGeometry,
  terminalFitWidthFontSize,
  terminalInitialHistoryRows,
  terminalMeasuredFitGeometry,
  terminalWebSocketUrl,
  type TerminalGeometry
} from "@/lib/terminal-helpers";
import { createTerminalDebugCapture } from "./terminal/terminal-debug";
import { createTerminalFrameWriter } from "./terminal/terminal-frames";
import { connectTerminal, type TerminalConnection, type TerminalConnectionStatus } from "./terminal/terminal-reconnect";
import { attachTerminalScrollHandlers } from "./terminal/terminal-scroll-handlers";
import { createProgramTracker } from "./terminal/terminal-scroll-routing";
import { TERMINAL_THEME } from "./terminal/terminal-theme";

type TerminalStatus = TerminalConnectionStatus;

export interface TerminalSelectionRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

interface UseTerminalSessionResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<Terminal | null>;
  fitAddonRef: React.RefObject<FitAddon | null>;
  status: TerminalStatus;
  firstPaintReady: boolean;
  scrolledBack: boolean;
  hasSelection: boolean;
  selectionPosition: TerminalSelectionRange | null;
  sendInput: (data: string) => void;
  sendResize: (geometry: TerminalGeometry) => void;
  sendFit: (geometry: TerminalGeometry | null) => void;
  sendRefresh: () => void;
  focusTerminal: () => void;
  scrollToBottom: () => void;
  copySelection: (options?: { restoreFocus?: boolean }) => Promise<string | null>;
}

interface UseTerminalSessionOptions {
  transformInput?: (data: string) => string;
  initialFitBrowser?: boolean;
  fitWidth?: boolean;
  requestWebFit?: boolean;
}

export function useTerminalSession(
  /** `program`, when given, is the pane's program through any wrapper
   *  (selectTerminalPane); without it, it is read from the pane itself. */
  pane: (SnapshotPane & { program?: string }) | null | undefined,
  projectId: string | null | undefined,
  options: UseTerminalSessionOptions = {}
): UseTerminalSessionResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sendRef = useRef<((payload: object) => void) | null>(null);
  const transformInputRef = useRef(options.transformInput);
  // Read when a reconnect builds its URL, so it asks for the fit mode the
  // user is in now rather than the one the page opened with.
  const requestWebFitRef = useRef(options.requestWebFit);
  // Read on every scroll: the pane's program changes under a mounted terminal.
  // The program itself, not a wrapper tmux names instead (`node …/codex`).
  const program = pane?.program ?? getPaneDisplayCommand(pane);
  const [programTracker] = useState(createProgramTracker);
  const firstPaintReadyRef = useRef(true);

  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [firstPaintReady, setFirstPaintReady] = useState(true);
  const [scrolledBack, setScrolledBack] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [selectionPosition, setSelectionPosition] = useState<TerminalSelectionRange | null>(null);

  useEffect(() => {
    transformInputRef.current = options.transformInput;
  }, [options.transformInput]);

  useEffect(() => {
    requestWebFitRef.current = options.requestWebFit;
  }, [options.requestWebFit]);

  useEffect(() => {
    programTracker.setSnapshot(program);
  }, [programTracker, program]);

  const updateScrolledBack = useCallback((terminal: Terminal | null = terminalRef.current) => {
    const buffer = terminal?.buffer.active;
    setScrolledBack(Boolean(buffer && buffer.viewportY < buffer.baseY));
  }, []);

  const sendInput = useCallback((data: string) => {
    if (!data) return;
    sendRef.current?.({ type: "input", data });
  }, []);

  const sendResize = useCallback((geometry: TerminalGeometry) => {
    sendRef.current?.({ type: "resize", cols: geometry.cols, rows: geometry.rows });
  }, []);

  const sendFit = useCallback((geometry: TerminalGeometry | null) => {
    if (!geometry) {
      sendRef.current?.({ type: "fit", enabled: false });
      return;
    }
    sendRef.current?.({ type: "fit", enabled: true, cols: geometry.cols, rows: geometry.rows });
  }, []);

  const sendRefresh = useCallback(() => {
    sendRef.current?.({ type: "refresh" });
  }, []);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const scrollToBottom = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.scrollToBottom();
    updateScrolledBack(terminal);
  }, [updateScrolledBack]);

  const clearSelection = useCallback(() => {
    terminalRef.current?.clearSelection();
    setHasSelection(false);
    setSelectionPosition(null);
  }, []);

  const copySelection = useCallback(async (options?: { restoreFocus?: boolean }): Promise<string | null> => {
    const text = terminalRef.current?.getSelection() ?? "";
    if (!text) return null;
    const ok = await copyTextToClipboard(text);
    // Restore terminal focus so the user can keep typing (the insecure-context
    // fallback moves focus to a hidden textarea).
    if (options?.restoreFocus !== false) terminalRef.current?.focus();
    if (ok) clearSelection();
    return ok ? text : null;
  }, [clearSelection]);

  useLayoutEffect(() => {
    const paneId = pane?.paneId;
    const maskInitialPaint = Boolean(options.requestWebFit);
    firstPaintReadyRef.current = !maskInitialPaint;
    setFirstPaintReady(!maskInitialPaint);
    setStatus("connecting");
    setScrolledBack(false);
    setHasSelection(false);
    setSelectionPosition(null);
    // projectId is optional — when absent (session-rooted view of an
    // unmanaged tmux pane), the server falls back to the tmux runtime. Only
    // paneId is strictly required here.
    const container = containerRef.current;
    if (!paneId || !container) return undefined;
    container.replaceChildren();

    let disposed = false;
    const initialGeometry = options.initialFitBrowser
      ? terminalBrowserFitGeometry(container, pane, { fitWidth: options.fitWidth })
      : paneTerminalGeometry(pane);
    const initialHistoryRows = terminalInitialHistoryRows();
    const initialFontSize = options.initialFitBrowser && options.fitWidth && isMobileTerminalViewport()
      ? terminalFitWidthFontSize(container, MOBILE_WEB_FIT_WIDTH_COLS)
      : TERMINAL_FONT_SIZE;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cols: initialGeometry.cols,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: initialFontSize,
      lineHeight: TERMINAL_LINE_HEIGHT,
      rows: initialGeometry.rows,
      // Match the server's requested initial-capture history depth so wheel
      // scroll stays local without making first paint process huge scrollback.
      scrollback: Math.max(initialHistoryRows, initialGeometry.rows),
      theme: TERMINAL_THEME
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Once xterm is actually mounted, FitAddon can measure the real cell
    // height. Use that geometry for the initial Web fit request; the earlier
    // browser estimate can be off by a few rows on mobile and leaves bottom
    // lines clipped until a later resize.
    const wsGeometry = options.initialFitBrowser
      ? (terminalMeasuredFitGeometry(terminal, fitAddon, container, pane, { fitWidth: options.fitWidth }) ?? initialGeometry)
      : initialGeometry;
    if (terminal.cols !== wsGeometry.cols || terminal.rows !== wsGeometry.rows) {
      terminal.resize(wsGeometry.cols, wsGeometry.rows);
    }

    // One socket at a time; a reconnect replaces it. Input typed while no
    // socket is open is dropped, never queued: replaying keystrokes into a
    // shell after an unknown gap is not safe.
    let currentSocket: WebSocket | null = null;
    const send = (payload: object) => {
      if (currentSocket?.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify(payload));
      }
    };
    sendRef.current = send;

    const { recordIn, recordOut } = createTerminalDebugCapture();

    const inputDisposable = terminal.onData((data) => {
      const outgoing = transformInputRef.current?.(data) ?? data;
      if (!outgoing) return;
      recordOut(outgoing);
      send({ type: "input", data: outgoing });
    });
    const scrollDisposable = terminal.onScroll(() => {
      updateScrolledBack(terminal);
    });
    const writeDisposable = terminal.onWriteParsed(() => {
      updateScrolledBack(terminal);
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      const position = terminal.getSelectionPosition() ?? null;
      setHasSelection(Boolean(position));
      setSelectionPosition(position);
    });

    // A program that just took the whole screen is often not in any snapshot
    // yet (the poll runs every few seconds), and where a scroll goes depends
    // on which program it is: ask for the pane's program now.
    const bufferDisposable = terminal.buffer.onBufferChange((buffer) => {
      if (buffer.type !== "alternate") {
        programTracker.leaveAlternate();
        return;
      }
      programTracker.enterAlternate(fetch(api.paneById(paneId))
        .then((response) => (response.ok ? response.json() as Promise<PaneByIdResponse> : null))
        .then((body) => (body && !("error" in body) ? getPaneDisplayCommand(body) : null)));
    });

    const detachScrollHandlers = attachTerminalScrollHandlers(container, terminal, {
      sendInput: (data) => send({ type: "input", data }),
      readsWheel: () => programTracker.readsWheel()
    });

    // Shared by every socket, so a replacement's reset and capture are only
    // written after the previous socket's last frames.
    let incomingQueue = Promise.resolve();
    let openedGeometry = wsGeometry;
    let connection: TerminalConnection | null = null;
    const writeText = (text: string) => new Promise<void>((resolve) => {
      if (disposed) {
        resolve();
        return;
      }
      recordIn(text);
      terminal.write(text, () => {
        if (!disposed && !firstPaintReadyRef.current) {
          firstPaintReadyRef.current = true;
          setFirstPaintReady(true);
        }
        resolve();
      });
    });

    connection = connectTerminal({
      open: (attempt) => {
        // A reconnect asks for the terminal's current size and fit mode;
        // either may have changed since the page opened.
        openedGeometry = attempt === 0 ? wsGeometry : { cols: terminal.cols, rows: terminal.rows };
        const fit = attempt === 0 ? options.requestWebFit : requestWebFitRef.current;
        const ws = new WebSocket(
          terminalWebSocketUrl(
            paneId,
            projectId ?? null,
            openedGeometry.cols,
            openedGeometry.rows,
            initialHistoryRows,
            { fit }
          )
        );
        // tmux pipe-pane frames are binary. The browser defaults binary WS
        // messages to Blob, which makes each onmessage handler asynchronous when
        // decoded with Blob.text()/arrayBuffer(). High-volume TUI redraws can then
        // be written to xterm out of order. ArrayBuffer keeps the hot path
        // synchronous; the streaming decoder also preserves UTF-8 sequences split
        // across socket chunks.
        ws.binaryType = "arraybuffer";
        currentSocket = ws;
        // Server streams raw pane bytes (initial capture + alt-screen /
        // cursor priming, then live pipe-pane output). xterm accumulates
        // everything in its own scrollback so wheel scroll is fully local.
        const writeFrame = createTerminalFrameWriter({
          resetFirst: attempt > 0,
          reset: () => {
            if (!disposed) terminal.reset();
          },
          onFrame: () => connection?.markHealthy(ws),
          write: writeText
        });
        ws.onmessage = (event) => {
          incomingQueue = incomingQueue
            .then(() => (disposed ? undefined : writeFrame(event.data)))
            .catch((err) => {
              console.warn("[terminal] failed to process incoming frame", err);
            });
        };
        return ws;
      },
      onOpen: () => {
        send({ type: "resize", cols: openedGeometry.cols, rows: openedGeometry.rows });
      },
      onStatus: (next) => {
        if (!disposed) setStatus(next);
      }
    });

    // The app's event stream reopening means the backend is back: skip the
    // rest of any backoff. Coming back online means the same for the network.
    const reconnectNow = () => connection?.reconnectNow();
    window.addEventListener("mandate:sse-open", reconnectNow);
    window.addEventListener("online", reconnectNow);

    return () => {
      disposed = true;
      inputDisposable.dispose();
      scrollDisposable.dispose();
      writeDisposable.dispose();
      selectionDisposable.dispose();
      bufferDisposable.dispose();
      detachScrollHandlers();
      window.removeEventListener("mandate:sse-open", reconnectNow);
      window.removeEventListener("online", reconnectNow);
      sendRef.current = null;
      connection?.dispose();
      currentSocket = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      firstPaintReadyRef.current = true;
    };
    // Re-run only when the pane id (or its owning project) changes — not
    // on every snapshot tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane?.paneId, projectId, updateScrolledBack]);

  return {
    containerRef,
    terminalRef,
    fitAddonRef,
    status,
    firstPaintReady,
    scrolledBack,
    hasSelection,
    selectionPosition,
    sendInput,
    sendResize,
    sendFit,
    sendRefresh,
    focusTerminal,
    scrollToBottom,
    copySelection
  };
}
