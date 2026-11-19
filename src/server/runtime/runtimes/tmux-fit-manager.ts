import type { WSContext } from "hono/ws";
import * as fs from "node:fs";
import * as path from "node:path";
import { resourceDir } from "../../platform/fs/resources.js";
import { Mutex } from "async-mutex";
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
  /** The window's own window-size option before the fit: null when it had
   *  none and took tmux's. Resizing a window sets it to manual, so giving
   *  the window back puts this back. Absent in a lease file an older
   *  version left: then it is left as it is. */
  windowSize?: string | null;
}

interface FitLease {
  windowId: string;
  targetPaneId: string;
  state: TmuxWindowState;
  clients: Set<WSContext>;
  filePath: string;
  restoring: boolean;
  restoreTimer: ReturnType<typeof setTimeout> | null;
  /** The size the window was last given. */
  size: TerminalGeometry | null;
  /** Who held it before viewers of other panes took it, the latest last:
   *  when the last one holding it lets go, the latest of them still there
   *  get it back, rather than it being put back as it was. Each lets go of
   *  its claim as it detaches or fits again. */
  previous: Array<{ paneId: string; size: TerminalGeometry; clients: Set<WSContext>; webActiveAt: number }>;
  /** When a viewer holding it last used it (ms): asked for its fit, typed.
   *  A terminal on the window used after that takes the window back from
   *  viewers on Auto (yieldToActiveClients). */
  webActiveAt: number;
}

export type FitResult =
  | { type: "fit"; size: TerminalGeometry; kept?: true }
  /** A resume on Auto for a window given back since: not taken; the pane's size. */
  | { type: "given-back"; size: TerminalGeometry | null };

/**
 * A browser's "fit": the tmux window zoomed to one pane and resized to the
 * browser's terminal while any viewer of it holds the lease, and put back as
 * it was when the last one lets go. Each step is several tmux commands
 * reading and changing the window, so every operation runs alone, one after
 * another in the order asked: tmux answers while the server goes on, and two
 * at once would read each other's half-changed window.
 */
export class TmuxFitManager {
  private readonly activeFitLeases = new Map<string, FitLease>();
  private readonly fitClients = new Map<WSContext, string>();
  private readonly fitStateDir = resourceDir({ kind: "global" }, "fit-leases");
  private readonly ops = new Mutex();
  /** Shut down: no lease is taken or resized any more. */
  private closed = false;

  constructor(
    private readonly options: {
      tmuxClient: TmuxClient;
      onWindowChanged?: (windowId: string) => void;
      restoreDelayMs?: number;
      /** A viewer's fit was taken by a viewer of another pane in its window:
       *  that pane is no longer zoomed to its size. */
      onFitTaken?: (ws: WSContext, paneId: string) => void;
      /** It was given back: the window is its pane's again, at its size. */
      onFitReturned?: (ws: WSContext, paneId: string) => void;
      now?: () => number;
    }
  ) {}

  /** Viewers on Auto: their fit is the window's only while no terminal on
   *  it was used since. */
  private readonly autoClients = new Set<WSContext>();
  /** When the web last used each window it no longer holds (its lease's
   *  webActiveAt as the lease ended: given back, let go, or its socket
   *  gone). A resume is measured against it, not taken for a use. */
  private readonly lastWebUse = new Map<string, number>();
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  sweepStaleFitLeases(): Promise<void> {
    return this.ops.runExclusive(async () => {
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
          await this.restoreWindowState(state);
        } catch { /* ignore stale/corrupt fit state */ }
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    });
  }

  /** Shutdown: from now on no lease is taken (a fit still waiting its turn
   *  finds none), and every window held is put back, side by side, in the
   *  little time a shutdown has. A lease file left by a slow tmux is put back
   *  at the next start. */
  restoreAll(): Promise<void> {
    this.closed = true;
    return this.ops.runExclusive(async () => {
      await Promise.all([...this.activeFitLeases.values()].map((lease) => this.restoreFitLease(lease)));
      this.activeFitLeases.clear();
      this.fitClients.clear();
    });
  }

  /** `keep`: when the viewer holds its pane's fit at this size already, it
   *  is kept as it is (`kept`), tmux asked nothing. `beforeChange` runs once
   *  it is known the window will change, before tmux is asked anything. Both
   *  in the same turn, so whatever is asked meanwhile (another fit, a
   *  release) comes before or after the whole of it. */
  applyFit(
    paneId: string,
    ws: WSContext,
    geometry: TerminalGeometry,
    options: { keep?: boolean; beforeChange?: () => void; auto?: boolean; resume?: boolean } = {}
  ): Promise<FitResult | null> {
    return this.ops.runExclusive(() => this.applyFitNow(paneId, ws, geometry, options));
  }

  private async applyFitNow(
    paneId: string,
    ws: WSContext,
    geometry: TerminalGeometry,
    options: { keep?: boolean; beforeChange?: () => void; auto?: boolean; resume?: boolean }
  ): Promise<FitResult | null> {
    if (this.closed) return null;
    if (options.keep && this.holds(ws, paneId, geometry)) {
      this.setAuto(ws, options.auto === true);
      if (!options.resume) this.markActive(ws);
      return { type: "fit", size: geometry, kept: true };
    }
    options.beforeChange?.();
    const state = await this.captureTmuxWindowState(paneId);
    if (!state) {
      return null;
    }
    // A socket come back on Auto (not a use) takes no window another viewer
    // holds, nor one a terminal on it was used on since the web last did;
    // one it takes is the web's as last used, not as of now.
    let usedAt = this.now();
    if (options.resume && options.auto) {
      // A socket come back takes only what nobody took meanwhile: not a
      // window another viewer holds (a lease with nobody left, waiting to be
      // put back, holds nothing), nor one a terminal used since the web last
      // did. With no record of that use (the server started since), it
      // takes nothing.
      const held = this.activeFitLeases.get(state.windowId);
      if (held && held.clients.size > 0 && !held.clients.has(ws)) return { type: "given-back", size: await this.paneSize(paneId) };
      const last = held ? held.webActiveAt : this.lastWebUse.get(state.windowId);
      if (last === undefined) return { type: "given-back", size: await this.paneSize(paneId) };
      const terminalUsed = (await this.terminalsUsedAt())?.get(state.windowId);
      if (terminalUsed !== undefined && terminalUsed > last) return { type: "given-back", size: await this.paneSize(paneId) };
      usedAt = last;
    }

    this.releaseClientNow(ws, false);

    let lease = this.activeFitLeases.get(state.windowId);
    if (!lease) {
      lease = {
        windowId: state.windowId,
        targetPaneId: paneId,
        state,
        clients: new Set(),
        filePath: this.fitStatePath(state.windowId),
        restoring: false,
        restoreTimer: null,
        size: null,
        previous: [],
        webActiveAt: this.now()
      };
      this.activeFitLeases.set(state.windowId, lease);
      this.persistFitLease(lease);
      await this.zoomPaneForFit(paneId, state);
    } else {
      this.cancelFitRestore(lease);
    }

    if (lease.targetPaneId !== paneId) {
      if (lease.clients.size > 0 && lease.size) {
        lease.previous.push({ paneId: lease.targetPaneId, size: lease.size, clients: new Set(lease.clients), webActiveAt: lease.webActiveAt });
      }
      for (const client of lease.clients) {
        this.fitClients.delete(client);
        this.options.onFitTaken?.(client, lease.targetPaneId);
      }
      lease.clients.clear();
      await this.zoomPaneForFit(paneId, (await this.captureTmuxWindowState(paneId)) ?? state);
      lease.targetPaneId = paneId;
    }

    lease.clients.add(ws);
    this.fitClients.set(ws, lease.windowId);
    this.setAuto(ws, options.auto === true);
    if (!options.resume) lease.webActiveAt = this.now();
    else if (lease.clients.size === 1) lease.webActiveAt = usedAt;
    await this.resizeFitWindow(lease.windowId, geometry);
    lease.size = geometry;
    this.options.onWindowChanged?.(lease.windowId);
    return { type: "fit", size: geometry };
  }

  private setAuto(ws: WSContext, auto: boolean): void {
    if (auto) this.autoClients.add(ws);
    else this.autoClients.delete(ws);
  }

  /** The viewer used its terminal (it asked for its fit again, as the
   *  browser does when it is used): the window stays its own until a
   *  terminal on it is used after this. */
  private markActive(ws: WSContext): void {
    const windowId = this.fitClients.get(ws);
    const lease = windowId ? this.activeFitLeases.get(windowId) : null;
    if (lease?.clients.has(ws)) lease.webActiveAt = this.now();
  }

  /**
   * Windows held only by viewers on Auto, given back to a terminal on them
   * used since those viewers last did (tmux's own rule for its clients:
   * the latest used sets the size). A terminal counts while it shows the
   * window and is used by a key or the mouse, as tmux records it in
   * `client_activity` (whole seconds); a control client (Mandate's own
   * tools, an IDE) never. A window another pane's viewer took meanwhile
   * goes back too when all who claim it (`previous` included) are on Auto:
   * used after the latest of them asked, it is the terminal's. The holders
   * are named with their pane's size as given back (null when tmux did not
   * say), for their views to take before anything is painted for them.
   */
  yieldToActiveClients(
    /** Told each window's holders before tmux is asked to change it, so
     *  what their pane redraws meanwhile can be held from them. */
    beforeGiveBack?: (holders: WSContext[], paneId: string) => void
  ): Promise<Array<{ ws: WSContext; paneId: string; size: TerminalGeometry | null }>> {
    return this.ops.runExclusive(async () => {
      if (this.closed) return [];
      const onAuto = (clients: Iterable<WSContext>) => [...clients].every((client) => this.autoClients.has(client));
      const held = [...this.activeFitLeases.values()].filter((lease) =>
        !lease.restoring && lease.clients.size > 0 && onAuto(lease.clients)
        && lease.previous.every((holders) => onAuto(holders.clients)));
      if (held.length === 0) return [];
      const usedAt = await this.terminalsUsedAt();
      if (!usedAt) return [];
      const yielded: Array<{ ws: WSContext; paneId: string; size: TerminalGeometry | null }> = [];
      for (const lease of held) {
        const at = usedAt.get(lease.windowId);
        if (at === undefined || at <= lease.webActiveAt) continue;
        // Its holder, then those it was taken from, the latest first.
        const claims = [{ paneId: lease.targetPaneId, clients: [...lease.clients] }, ...[...lease.previous].reverse().map((holders) => ({ paneId: holders.paneId, clients: [...holders.clients] }))];
        for (const claim of claims) beforeGiveBack?.(claim.clients, claim.paneId);
        lease.previous = [];
        await this.restoreFitLease(lease);
        for (const claim of claims) {
          const size = await this.paneSize(claim.paneId);
          for (const holder of claim.clients) yielded.push({ ws: holder, paneId: claim.paneId, size });
        }
        this.options.onWindowChanged?.(lease.windowId);
      }
      return yielded;
    });
  }

  private holds(ws: WSContext, paneId: string, geometry: TerminalGeometry): boolean {
    const windowId = this.fitClients.get(ws);
    const lease = windowId ? this.activeFitLeases.get(windowId) : null;
    return Boolean(lease && !lease.restoring && lease.clients.has(ws) && lease.targetPaneId === paneId
      && lease.size?.cols === geometry.cols && lease.size.rows === geometry.rows);
  }

  releaseClient(
    ws: WSContext,
    restoreWhenLast = true,
    restoreDelayMs = this.options.restoreDelayMs ?? FIT_RESTORE_GRACE_MS
  ): Promise<void> {
    return this.ops.runExclusive(async () => {
      const lease = this.releaseClientNow(ws, restoreWhenLast);
      if (lease) await this.scheduleFitRestore(lease, restoreDelayMs);
    });
  }

  /** Lets go of the viewer's lease; the lease when it was the last one to
   *  hold it and the window should be put back. */
  private releaseClientNow(ws: WSContext, restoreWhenLast: boolean): FitLease | null {
    for (const lease of this.activeFitLeases.values()) {
      for (const holders of lease.previous) holders.clients.delete(ws);
      lease.previous = lease.previous.filter((holders) => holders.clients.size > 0);
    }
    this.autoClients.delete(ws);
    const windowId = this.fitClients.get(ws);
    if (!windowId) return null;
    this.fitClients.delete(ws);
    const lease = this.activeFitLeases.get(windowId);
    if (!lease) return null;
    lease.clients.delete(ws);
    return restoreWhenLast && lease.clients.size === 0 ? lease : null;
  }

  resizeForClient(ws: WSContext, paneId: string, geometry: TerminalGeometry): Promise<boolean> {
    return this.ops.runExclusive(async () => {
      if (this.closed) return false;
      const windowId = this.fitClients.get(ws);
      const lease = windowId ? this.activeFitLeases.get(windowId) : null;
      if (typeof windowId !== "string" || lease?.targetPaneId !== paneId || !lease.clients.has(ws)) {
        return false;
      }
      await this.resizeFitWindow(windowId, geometry);
      lease.size = geometry;
      this.options.onWindowChanged?.(windowId);
      return true;
    });
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

  private async scheduleFitRestore(lease: FitLease, delayMs: number): Promise<void> {
    this.cancelFitRestore(lease);
    if (delayMs <= 0) {
      await this.giveBackOrRestore(lease);
      this.options.onWindowChanged?.(lease.windowId);
      return;
    }
    const timer = setTimeout(() => {
      lease.restoreTimer = null;
      void this.ops.runExclusive(async () => {
        // Asked again in turn: a viewer may have taken the lease up meanwhile.
        if (lease.clients.size > 0 || this.activeFitLeases.get(lease.windowId) !== lease) return;
        await this.giveBackOrRestore(lease);
        this.options.onWindowChanged?.(lease.windowId);
      });
    }, delayMs);
    timer.unref?.();
    lease.restoreTimer = timer;
  }

  private cancelFitRestore(lease: FitLease): void {
    if (!lease.restoreTimer) return;
    clearTimeout(lease.restoreTimer);
    lease.restoreTimer = null;
  }

  private async captureTmuxWindowState(paneId: string): Promise<TmuxWindowState | null> {
    const windowState = await tmuxCommand(
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
    const activePaneId = (await this.activePaneForWindow(windowId)) || paneId;
    // The window's own option only (no -g, no inherited value): empty when
    // it takes tmux's.
    const own = await tmuxCommand(this.options.tmuxClient, ["show-options", "-wqv", "-t", windowId, "window-size"], { timeout: 1000 });
    return {
      windowId,
      layout,
      activePaneId,
      width: positiveInteger(width, 80),
      height: positiveInteger(height, 24),
      zoomed: zoomed === "1",
      windowSize: own.status === 0 ? (String(own.stdout || "").trim() || null) : undefined
    };
  }

  /** When a terminal showing each window was last used (ms), as tmux
   *  records its clients' activity (whole seconds); control clients never
   *  count. Null when tmux did not answer. */
  private async terminalsUsedAt(): Promise<Map<string, number> | null> {
    const listed = await tmuxCommand(
      this.options.tmuxClient,
      ["list-clients", "-F", ["#{client_control_mode}", "#{window_id}", "#{client_activity}"].join(TMUX_FIELD_SEP)],
      { timeout: 1000 }
    );
    if (listed.status !== 0) return null;
    const usedAt = new Map<string, number>();
    for (const line of String(listed.stdout || "").split("\n")) {
      const [control, windowId, activity] = line.trim().split(TMUX_FIELD_SEP);
      const seconds = Number(activity);
      if (control !== "0" || !windowId || !Number.isFinite(seconds)) continue;
      usedAt.set(windowId, Math.max(usedAt.get(windowId) ?? 0, seconds * 1000));
    }
    return usedAt;
  }

  private async paneSize(paneId: string): Promise<TerminalGeometry | null> {
    const result = await tmuxCommand(
      this.options.tmuxClient,
      ["display-message", "-p", "-t", paneId, ["#{pane_width}", "#{pane_height}"].join(TMUX_FIELD_SEP)],
      { timeout: 1000 }
    );
    if (result.status !== 0) return null;
    const [cols, rows] = String(result.stdout || "").trim().split(TMUX_FIELD_SEP).map(Number);
    return cols && rows ? { cols, rows } : null;
  }

  private async activePaneForWindow(windowId: string): Promise<string> {
    const result = await tmuxCommand(
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

  private async zoomPaneForFit(paneId: string, state: TmuxWindowState): Promise<void> {
    if (state.zoomed && state.activePaneId === paneId) {
      return;
    }
    if (state.zoomed) {
      await tmuxCommand(this.options.tmuxClient, ["resize-pane", "-Z", "-t", state.activePaneId], { timeout: 1000 });
    }
    await tmuxCommand(this.options.tmuxClient, ["select-pane", "-t", paneId], { timeout: 1000 });
    await tmuxCommand(this.options.tmuxClient, ["resize-pane", "-Z", "-t", paneId], { timeout: 1000 });
  }

  private async resizeFitWindow(windowId: string, geometry: TerminalGeometry): Promise<void> {
    await tmuxCommand(
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

  /** The last one who held the window let go: those it was taken from get
   *  it back, while any of them is still there and so is their pane; else it
   *  is put back as it was. */
  private async giveBackOrRestore(lease: FitLease): Promise<void> {
    let previous: FitLease["previous"][number] | undefined;
    let state: TmuxWindowState | null = null;
    // The latest still there whose pane is still in this window.
    while (!this.closed && (previous = lease.previous.pop())) {
      if (previous.clients.size === 0) continue;
      state = await this.captureTmuxWindowState(previous.paneId);
      if (state?.windowId === lease.windowId) break;
      state = null;
    }
    if (!previous || !state) {
      lease.previous = [];
      await this.restoreFitLease(lease);
      return;
    }
    await this.zoomPaneForFit(previous.paneId, state);
    lease.targetPaneId = previous.paneId;
    for (const client of previous.clients) {
      lease.clients.add(client);
      this.fitClients.set(client, lease.windowId);
    }
    await this.resizeFitWindow(lease.windowId, previous.size);
    lease.size = previous.size;
    // Theirs as they last used it: coming back is not being used.
    lease.webActiveAt = previous.webActiveAt;
    for (const client of previous.clients) this.options.onFitReturned?.(client, previous.paneId);
  }

  private async restoreFitLease(lease: FitLease): Promise<void> {
    if (lease.restoring) return;
    lease.restoring = true;
    this.lastWebUse.set(lease.windowId, lease.webActiveAt);
    this.cancelFitRestore(lease);
    this.activeFitLeases.delete(lease.windowId);
    for (const client of lease.clients) {
      this.fitClients.delete(client);
    }
    lease.clients.clear();
    await this.restoreWindowState(lease.state);
    try { fs.unlinkSync(lease.filePath); } catch { /* ignore */ }
  }

  private async restoreWindowState(state: TmuxWindowState): Promise<void> {
    if (!state.windowId || !state.layout) return;

    const probe = await tmuxCommand(
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
        await tmuxCommand(this.options.tmuxClient, ["resize-pane", "-Z", "-t", currentActivePaneId], { timeout: 1000 });
      }
    }

    await tmuxCommand(
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
    await tmuxCommand(this.options.tmuxClient, ["select-layout", "-t", state.windowId, state.layout], { timeout: 1000 });
    if (state.activePaneId) {
      await tmuxCommand(this.options.tmuxClient, ["select-pane", "-t", state.activePaneId], { timeout: 1000 });
    }
    if (state.zoomed && state.activePaneId) {
      await tmuxCommand(this.options.tmuxClient, ["resize-pane", "-Z", "-t", state.activePaneId], { timeout: 1000 });
    }
    // Last: the window's own size rule again, which resize-window set to
    // manual. With none of its own it follows tmux's again (window-size
    // latest by default: the size of the terminal last used on it).
    if (state.windowSize === null) {
      await tmuxCommand(this.options.tmuxClient, ["set-option", "-w", "-u", "-t", state.windowId, "window-size"], { timeout: 1000 });
    } else if (typeof state.windowSize === "string") {
      await tmuxCommand(this.options.tmuxClient, ["set-option", "-w", "-t", state.windowId, "window-size", state.windowSize], { timeout: 1000 });
    }
  }
}
