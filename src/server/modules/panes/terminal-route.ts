import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { TmuxRuntime } from "../../runtime/runtimes/tmux-runtime.js";
import type { ViewerHandle } from "../../runtime/pane-runtime.js";
import { errorText } from "../../../shared/error-text.js";

// Thin dispatcher: parse `?paneId=...&cols=...&rows=...` from the upgrade URL
// and hand off to the tmux runtime's attachViewer, which speaks to any pane by
// id. All per-pane plumbing (pipe, fit lease, send-keys) lives inside it.

const MIN_COLS = 20, MAX_COLS = 300;
const MIN_ROWS = 8, MAX_ROWS = 200;
const DEFAULT_COLS = 80, DEFAULT_ROWS = 24;
const MIN_HISTORY_ROWS = 0, MAX_HISTORY_ROWS = 5000;
const DEFAULT_HISTORY_ROWS = 1000;

/** Closed with this when the pane it names is gone, or its id now belongs to
 *  another pane (tmux gives ids out again after its server restarts). */
export const PANE_CLOSED_CODE = 4404;

export interface TerminalRouteDeps {
  tmuxRuntime: Pick<TmuxRuntime, "attachViewer">;
  /** The pid of the pane that holds `paneId` now, null when none does. */
  panePid: (paneId: string) => Promise<number | null>;
}

export function mountTerminalRoute(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  deps: TerminalRouteDeps
): void {
  app.get(
    API_ROUTES.terminal,
    upgradeWebSocket((c) => {
      const url = new URL(c.req.url);
      const paneId = url.searchParams.get("paneId");
      const cols = clampInt(url.searchParams.get("cols"), DEFAULT_COLS, MIN_COLS, MAX_COLS);
      const rows = clampInt(url.searchParams.get("rows"), DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
      const historyRows = clampInt(
        url.searchParams.get("historyRows"),
        DEFAULT_HISTORY_ROWS,
        MIN_HISTORY_ROWS,
        MAX_HISTORY_ROWS
      );
      const fit = url.searchParams.get("fit") === "1";
      // On Auto: a terminal on the window used after this viewer takes it back.
      const auto = url.searchParams.get("auto") === "1";
      const resume = auto && url.searchParams.get("resume") === "1";

      const pidParam = url.searchParams.get("pid");
      const expectPid = pidParam && Number.isFinite(Number(pidParam)) ? Number(pidParam) : null;
      let viewer: TerminalViewer | null = null;
      const letGo = () => {
        viewer?.detach();
        viewer = null;
      };

      return {
        onOpen: (_event, ws) => {
          if (!paneId) {
            ws.close(1008, "paneId required");
            return;
          }
          viewer = openTerminalViewer({ paneId, expectPid, cols, rows, fit, auto, resume, historyRows }, ws, deps);
        },
        // Hono's WSContext exposes no addEventListener API, so the runtime
        // can't subscribe to messages itself — route every browser→server
        // frame through the viewer.
        onMessage: (event) => {
          viewer?.handleMessage(event.data);
        },
        onClose: letGo,
        onError: letGo
      };
    })
  );
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

interface TerminalViewer {
  handleMessage(data: unknown): void;
  detach(): void;
}

/** How long a pid answer stands for a viewer opened with one. tmux restarted
 *  meanwhile can hand the id to another process, and the viewer's input goes
 *  by id: what comes after a longer quiet waits for tmux to be asked again. */
export const PID_RECHECK_MS = 1000;

/** Attaches a viewer to the pane. Given the pid the page knows the pane by,
 *  the attach waits for tmux to say that pane still holds the id, and so does
 *  what the browser sends after a quiet longer than PID_RECHECK_MS: a
 *  different pid closes the socket instead, so nothing typed reaches another
 *  pane. What the browser sends meanwhile is kept and handed over in order. */
export function openTerminalViewer(
  params: { paneId: string; expectPid: number | null; cols: number; rows: number; fit: boolean; auto?: boolean; resume?: boolean; historyRows: number },
  ws: WSContext,
  deps: TerminalRouteDeps
): TerminalViewer {
  let handle: ViewerHandle | null = null;
  let gone = false;
  let checking = false;
  let confirmedAt = 0;
  const waiting: unknown[] = [];
  // The viewer left while its frames waited on a recheck: what it sent is
  // still its word (TmuxRuntime takes a detached viewer's input), so it goes
  // to the pane once tmux says the pane is the same one, and nowhere if not.
  let leftWith: ViewerHandle | null = null;
  const close = (code: number, reason: string) => {
    gone = true;
    waiting.length = 0;
    handle?.detach();
    handle = null;
    ws.close(code, reason);
  };
  const flush = () => { for (const data of waiting.splice(0)) void handle?.handleMessage(data); };
  const attach = () => {
    // The handle comes back at once (the attach's tmux work is the first
    // steps of the pane's turn), so every frame from here on takes its place
    // in that turn as it comes.
    try {
      handle = deps.tmuxRuntime.attachViewer(params.paneId, ws, { cols: params.cols, rows: params.rows }, { fit: params.fit, auto: params.auto === true, resume: params.resume === true, historyRows: params.historyRows });
    } catch (err: unknown) {
      ws.close(1011, errorText(err, "attach failed"));
      return;
    }
    flush();
  };
  const check = () => {
    checking = true;
    void deps.panePid(params.paneId).then(
      (pid) => {
        checking = false;
        if (leftWith) {
          const sent = leftWith;
          leftWith = null;
          const frames = waiting.splice(0);
          if (pid === params.expectPid) for (const data of frames) void sent.handleMessage(data);
          return;
        }
        if (gone) return;
        if (pid !== params.expectPid) return close(PANE_CLOSED_CODE, "pane closed");
        confirmedAt = Date.now();
        if (handle) flush();
        else attach();
      },
      (err: unknown) => {
        checking = false;
        leftWith = null;
        waiting.length = 0;
        if (!gone) close(1011, errorText(err, handle ? "pane check failed" : "attach failed"));
      }
    );
  };
  if (params.expectPid === null) attach();
  else check();
  return {
    handleMessage: (data) => {
      if (gone) return;
      if (params.expectPid === null) {
        if (handle) void handle.handleMessage(data);
        return;
      }
      if (handle && !checking && waiting.length === 0 && Date.now() - confirmedAt < PID_RECHECK_MS) {
        void handle.handleMessage(data);
        return;
      }
      waiting.push(data);
      if (handle && !checking) check();
    },
    detach: () => {
      gone = true;
      if (checking && handle && waiting.length > 0) leftWith = handle;
      else waiting.length = 0;
      handle?.detach();
      handle = null;
    }
  };
}
