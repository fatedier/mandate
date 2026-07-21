import type { WSContext } from "hono/ws";
import * as fs from "node:fs";
import * as path from "node:path";
import { resourceDir } from "../../platform/fs/resources.js";
import { type TmuxClient, tmuxCommand } from "../../platform/tmux/tmux.js";
import { FIT_RESTORE_GRACE_MS, TMUX_FIELD_SEP } from "./tmux-runtime-constants.js";
import { positiveInteger, type TerminalGeometry } from "./tmux-runtime-utils.js";

interface TmuxWindowState {
  windowId: string;
  layout: string;
  activePaneId: string;
  width: number;
  height: number;
  zoomed: boolean;
}

interface FitLease {
  windowId: string;
  targetPaneId: string;
  state: TmuxWindowState;
  clients: Set<WSContext>;
  filePath: string;
  restoring: boolean;
  restoreTimer: ReturnType<typeof setTimeout> | null;
}

export class TmuxFitManager {
  private readonly activeFitLeases = new Map<string, FitLease>();
  private readonly fitClients = new Map<WSContext, string>();
  private readonly fitStateDir = resourceDir({ kind: "global" }, "fit-leases");

  constructor(
    private readonly options: {
      tmuxClient: TmuxClient;
      onWindowChanged?: (windowId: string) => void;
      restoreDelayMs?: number;
    }
  ) {}

  sweepStaleFitLeases(): void {
    // Restore EVERY fit-lease file unconditionally. By init(), no client has
    // attached to take over a lease, so any file present is from a previous run.
    fs.mkdirSync(this.fitStateDir, { recursive: true });
    let entries: string[] = [];
    try { entries = fs.readdirSync(this.fitStateDir); } catch { return; }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.fitStateDir, entry);
      try {
        const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as TmuxWindowState;
        this.restoreWindowState(state);
      } catch { /* ignore stale/corrupt fit state */ }
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  restoreAll(): void {
    for (const lease of this.activeFitLeases.values()) this.restoreFitLease(lease);
    this.activeFitLeases.clear();
    this.fitClients.clear();
  }

  applyFit(paneId: string, ws: WSContext, geometry: TerminalGeometry) {
    const state = this.captureTmuxWindowState(paneId);
    if (!state) {
      return null;
    }

    this.releaseClient(ws, false);

    let lease = this.activeFitLeases.get(state.windowId);
    if (!lease) {
      lease = {
        windowId: state.windowId,
        targetPaneId: paneId,
        state,
        clients: new Set(),
        filePath: this.fitStatePath(state.windowId),
        restoring: false,
        restoreTimer: null
      };
      this.activeFitLeases.set(state.windowId, lease);
      this.persistFitLease(lease);
      this.zoomPaneForFit(paneId, state);
    } else {
      this.cancelFitRestore(lease);
    }

    if (lease.targetPaneId !== paneId) {
      for (const client of lease.clients) {
        this.fitClients.delete(client);
      }
      lease.clients.clear();
      this.zoomPaneForFit(paneId, this.captureTmuxWindowState(paneId) ?? state);
      lease.targetPaneId = paneId;
    }

    lease.clients.add(ws);
    this.fitClients.set(ws, lease.windowId);
    this.resizeFitWindow(lease.windowId, geometry);
    this.options.onWindowChanged?.(lease.windowId);
    return { type: "fit", size: geometry };
  }

  releaseClient(
    ws: WSContext,
    restoreWhenLast = true,
    restoreDelayMs = this.options.restoreDelayMs ?? FIT_RESTORE_GRACE_MS
  ): void {
    const windowId = this.fitClients.get(ws);
    if (!windowId) return;
    this.fitClients.delete(ws);
    const lease = this.activeFitLeases.get(windowId);
    if (!lease) return;
    lease.clients.delete(ws);
    if (restoreWhenLast && lease.clients.size === 0) {
      this.scheduleFitRestore(lease, restoreDelayMs);
    }
  }

  resizeForClient(ws: WSContext, paneId: string, geometry: TerminalGeometry): boolean {
    const windowId = this.fitClients.get(ws);
    const lease = windowId ? this.activeFitLeases.get(windowId) : null;
    if (typeof windowId !== "string" || lease?.targetPaneId !== paneId || !lease.clients.has(ws)) {
      return false;
    }
    this.resizeFitWindow(windowId, geometry);
    this.options.onWindowChanged?.(windowId);
    return true;
  }

  hasClientLease(ws: WSContext, paneId: string): boolean {
    const windowId = this.fitClients.get(ws);
    const lease = windowId ? this.activeFitLeases.get(windowId) : null;
    return Boolean(lease?.clients.has(ws) && lease.targetPaneId === paneId);
  }

  private fitStatePath(windowId: string): string {
    const safe = windowId.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(this.fitStateDir, `${safe}.json`);
  }

  private scheduleFitRestore(lease: FitLease, delayMs: number): void {
    this.cancelFitRestore(lease);
    if (delayMs <= 0) {
      this.restoreFitLease(lease);
      this.options.onWindowChanged?.(lease.windowId);
      return;
    }
    const timer = setTimeout(() => {
      lease.restoreTimer = null;
      if (lease.clients.size > 0) return;
      this.restoreFitLease(lease);
      this.options.onWindowChanged?.(lease.windowId);
    }, delayMs);
    timer.unref?.();
    lease.restoreTimer = timer;
  }

  private cancelFitRestore(lease: FitLease): void {
    if (!lease.restoreTimer) return;
    clearTimeout(lease.restoreTimer);
    lease.restoreTimer = null;
  }

  private captureTmuxWindowState(paneId: string): TmuxWindowState | null {
    const windowState = tmuxCommand(
      this.options.tmuxClient,
      [
        "display-message",
        "-p",
        "-t",
        paneId,
        [
          "#{window_id}",
          "#{window_layout}",
          "#{window_zoomed_flag}",
          "#{window_width}",
          "#{window_height}"
        ].join(TMUX_FIELD_SEP)
      ],
      { timeout: 1000 }
    );
    if (windowState.status !== 0) return null;
    const [windowId, layout, zoomed, width, height] = String(windowState.stdout || "").trim().split(TMUX_FIELD_SEP);
    if (!windowId || !layout) return null;
    const activePaneId = this.activePaneForWindow(windowId) || paneId;
    return {
      windowId,
      layout,
      activePaneId,
      width: positiveInteger(width, 80),
      height: positiveInteger(height, 24),
      zoomed: zoomed === "1"
    };
  }

  private activePaneForWindow(windowId: string): string {
    const result = tmuxCommand(
      this.options.tmuxClient,
      ["list-panes", "-t", windowId, "-F", ["#{pane_id}", "#{pane_active}"].join(TMUX_FIELD_SEP)],
      { timeout: 1000 }
    );
    if (result.status !== 0) return "";
    for (const line of String(result.stdout || "").trim().split("\n")) {
      const [paneId, active] = line.split(TMUX_FIELD_SEP);
      if (active === "1") return paneId || "";
    }
    return "";
  }

  private zoomPaneForFit(paneId: string, state: TmuxWindowState): void {
    if (state.zoomed && state.activePaneId === paneId) {
      return;
    }
    if (state.zoomed) {
      tmuxCommand(this.options.tmuxClient, ["resize-pane", "-Z", "-t", state.activePaneId], { timeout: 1000 });
    }
    tmuxCommand(this.options.tmuxClient, ["select-pane", "-t", paneId], { timeout: 1000 });
    tmuxCommand(this.options.tmuxClient, ["resize-pane", "-Z", "-t", paneId], { timeout: 1000 });
  }

  private resizeFitWindow(windowId: string, geometry: TerminalGeometry): void {
    tmuxCommand(
      this.options.tmuxClient,
      [
        "resize-window",
        "-t",
        windowId,
        "-x",
        String(geometry.cols),
        "-y",
        String(geometry.rows)
      ],
      { timeout: 1000 }
    );
  }

  private persistFitLease(lease: FitLease): void {
    try {
      fs.writeFileSync(lease.filePath, JSON.stringify(lease.state), "utf8");
    } catch { /* ignore */ }
  }

  private restoreFitLease(lease: FitLease): void {
    if (lease.restoring) return;
    lease.restoring = true;
    this.cancelFitRestore(lease);
    this.activeFitLeases.delete(lease.windowId);
    for (const client of lease.clients) {
      this.fitClients.delete(client);
    }
    lease.clients.clear();
    this.restoreWindowState(lease.state);
    try { fs.unlinkSync(lease.filePath); } catch { /* ignore */ }
  }

  private restoreWindowState(state: TmuxWindowState): void {
    if (!state.windowId || !state.layout) return;

    const probe = tmuxCommand(
      this.options.tmuxClient,
      [
        "display-message",
        "-p",
        "-t",
        state.windowId,
        "#{window_zoomed_flag} #{pane_id}"
      ],
      { timeout: 1000 }
    );
    if (probe.status === 0) {
      const [zoomFlag, currentActivePaneId] = String(probe.stdout || "").trim().split(/\s+/);
      if (zoomFlag === "1" && currentActivePaneId) {
        tmuxCommand(this.options.tmuxClient, ["resize-pane", "-Z", "-t", currentActivePaneId], { timeout: 1000 });
      }
    }

    tmuxCommand(
      this.options.tmuxClient,
      [
        "resize-window",
        "-t",
        state.windowId,
        "-x",
        String(state.width),
        "-y",
        String(state.height)
      ],
      { timeout: 1000 }
    );
    tmuxCommand(this.options.tmuxClient, ["select-layout", "-t", state.windowId, state.layout], { timeout: 1000 });
    if (state.activePaneId) {
      tmuxCommand(this.options.tmuxClient, ["select-pane", "-t", state.activePaneId], { timeout: 1000 });
    }
    if (state.zoomed && state.activePaneId) {
      tmuxCommand(this.options.tmuxClient, ["resize-pane", "-Z", "-t", state.activePaneId], { timeout: 1000 });
    }
  }
}
