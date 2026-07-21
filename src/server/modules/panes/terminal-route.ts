import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { PaneRuntimeRegistry } from "../../runtime/pane-runtime-registry.js";
import type { ViewerHandle } from "../../runtime/pane-runtime.js";

// Thin dispatcher: parse `?paneId=...&projectId=...&cols=...&rows=...` from the
// upgrade URL, resolve the project's PaneRuntime, hand off to attachViewer.
// All per-pane plumbing (pipe, fit lease, send-keys) lives inside the runtime.

const MIN_COLS = 20, MAX_COLS = 300;
const MIN_ROWS = 8, MAX_ROWS = 200;
const DEFAULT_COLS = 80, DEFAULT_ROWS = 24;
const MIN_HISTORY_ROWS = 0, MAX_HISTORY_ROWS = 5000;
const DEFAULT_HISTORY_ROWS = 1000;

export interface TerminalRouteDeps {
  paneRuntimes: PaneRuntimeRegistry;
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
      const projectId = url.searchParams.get("projectId");
      const cols = clampInt(url.searchParams.get("cols"), DEFAULT_COLS, MIN_COLS, MAX_COLS);
      const rows = clampInt(url.searchParams.get("rows"), DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
      const historyRows = clampInt(
        url.searchParams.get("historyRows"),
        DEFAULT_HISTORY_ROWS,
        MIN_HISTORY_ROWS,
        MAX_HISTORY_ROWS
      );
      const fit = url.searchParams.get("fit") === "1";

      let handle: ViewerHandle | null = null;

      return {
        onOpen: async (_event, ws) => {
          if (!paneId) {
            ws.close(1008, "paneId required");
            return;
          }
          // projectId is OPTIONAL: unmanaged tmux panes reached from
          // /sessions/:sessionName/windows/:windowName/pane/:paneId do not
          // have an owning Mandate project. In that case we fall back to the
          // tmux runtime — the only one that can speak to a raw tmux pane by
          // id. Managed panes pass projectId so the dispatcher picks the
          // right runtime for the managed project.
          let runtime;
          if (projectId) {
            try {
              runtime = deps.paneRuntimes.forProject(projectId);
            } catch (err: unknown) {
              ws.close(1008, err instanceof Error ? err.message : "unknown project");
              return;
            }
          } else {
            runtime = deps.paneRuntimes.tmux;
          }
          try {
            handle = await runtime.attachViewer(paneId, ws, { cols, rows }, { fit, historyRows });
          } catch (err: unknown) {
            ws.close(1011, err instanceof Error ? err.message : "attach failed");
          }
        },
        // Hono's WSContext exposes no addEventListener API, so the runtime
        // can't subscribe to messages itself — route every browser→server
        // frame through the ViewerHandle returned by attachViewer.
        onMessage: (event) => {
          handle?.handleMessage(event.data);
        },
        onClose: () => {
          handle?.detach();
          handle = null;
        },
        onError: () => {
          handle?.detach();
          handle = null;
        }
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
