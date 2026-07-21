import type { WSContext } from "hono/ws";
import * as os from "node:os";
import type {
  PaneRuntime, Pane, ViewerHandle,
  SpawnPaneInput, ReadScrollbackOptions
} from "../pane-runtime.js";
import { type TmuxClient, tmuxCommand } from "../../platform/tmux/tmux.js";
import { commandFailureMessage, type CommandRunOptions } from "../../platform/process/command-runner.js";
import type { ProjectsStore } from "../../modules/projects/projects-store.js";
import type { FeaturesStore } from "../../modules/features/features-store.js";
import type { FeatureRow } from "../../modules/features/features-store.js";
import type { ProjectRow } from "../../modules/projects/projects-store.js";
import { reconcileFeature, reconcileProject } from "../../modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../../modules/projects/tmux-reconcile-adapter.js";
import {
  DEFAULT_INITIAL_HISTORY_ROWS,
  INITIAL_FIT_SETTLE_FIRST_SAMPLE_MS,
  INITIAL_FIT_SETTLE_MAX_MS,
  INITIAL_FIT_SETTLE_SAMPLE_MS,
  INITIAL_FIT_STABLE_SAMPLES,
  INPUT_CHUNK_BYTES,
  MAX_INITIAL_HISTORY_ROWS,
  MIN_INITIAL_HISTORY_ROWS,
  TMUX_FIELD_SEP,
  WS_OPEN
} from "./tmux-runtime-constants.js";
import { TmuxFitManager } from "./tmux-fit-manager.js";
import { TmuxPipeManager } from "./tmux-pipe-manager.js";
import { capturePaneInitial, capturePaneRefresh } from "./tmux-terminal-capture.js";
import {
  clampNumber,
  isRecord,
  messageToString,
  terminalSizeFromPayload
} from "./tmux-runtime-utils.js";

interface TmuxRuntimeDeps {
  tmuxClient: TmuxClient;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  /** Optional notifier called when a tmux window's geometry changes
   *  (apply-fit / release-fit / resize). The app container wires this to
   *  `poller.poll({ forceWindowIds: [id] })` so snapshot freshness is
   *  immediate instead of waiting up to pollIntervalMs. */
  onWindowChanged?: (windowId: string) => void;
  fitRestoreGraceMs?: number;
}

function splitDirectionForTarget(target: { width: number; height: number }): "right" | "down" {
  const visualWidth = Math.max(0, target.width) * 0.56;
  const visualHeight = Math.max(0, target.height);
  return visualWidth >= visualHeight ? "right" : "down";
}

export class TmuxRuntime implements PaneRuntime {
  readonly kind = "tmux" as const;

  private readonly fitSettleTimers = new Map<WSContext, ReturnType<typeof setTimeout>>();
  private readonly fitManager: TmuxFitManager;
  private readonly pipeManager: TmuxPipeManager;

  // Process-scoped prefix for pipe-pane fifos so a crashed instance can't
  // collide with the next one. init() sweeps stale fifos from previous runs.
  // These are scratch files with no reason to outlive the process, so tmpdir
  // rather than the data dir.
  private readonly pipeDir = os.tmpdir();
  private readonly pipePrefix = `mandate-pipe-${process.pid}`;

  constructor(private deps: TmuxRuntimeDeps) {
    this.fitManager = new TmuxFitManager({
      tmuxClient: deps.tmuxClient,
      onWindowChanged: deps.onWindowChanged,
      restoreDelayMs: deps.fitRestoreGraceMs
    });
    this.pipeManager = new TmuxPipeManager({
      tmuxClient: deps.tmuxClient,
      pipeDir: this.pipeDir,
      pipePrefix: this.pipePrefix
    });
  }

  async init(): Promise<Map<string, Pane[]>> {
    this.pipeManager.sweepStalePipes();
    this.fitManager.sweepStaleFitLeases();
    return new Map();
  }

  async dispose(): Promise<void> {
    // Runs on shutdown: server.ts wires SIGTERM/SIGINT/SIGHUP to
    // container.dispose(), which calls this.
    this.fitManager.restoreAll();
    for (const timer of this.fitSettleTimers.values()) clearTimeout(timer);
    this.fitSettleTimers.clear();
    this.pipeManager.disposeAll();
  }

  async spawnPane(input: SpawnPaneInput): Promise<Pane> {
    const feature = this.deps.featuresStore.getById(input.featureId);
    if (!feature) throw new Error(`feature ${input.featureId} not found`);
    const project = this.deps.projectsStore.getById(feature.projectId);
    if (!project) throw new Error(`project ${feature.projectId} not found`);

    // Splitting needs a window to split. When the feature's window has gone,
    // rebuild it first — the same reconcile the Create pane button runs before
    // it reaches here.
    //
    // Without this the two are not the same operation: the button recovers a
    // vanished window and the agent's `spawn_pane` only ever answers "can't
    // find window", so the one action that would unblock the feature is
    // reachable from the UI and from nowhere else. An agent that cannot see
    // the second path has nothing left but to wait for someone to take it.
    this.ensureFeatureWindow(feature, project);

    const windowTarget = `${project.tmuxSessionName}:${feature.tmuxWindowName}`;
    const target = this.resolveSpawnTarget(windowTarget, input.targetPaneId);
    const direction = input.direction ?? splitDirectionForTarget(target);
    const args = [
      "split-window",
      direction === "right" ? "-h" : "-v",
      "-d",
      "-t",
      target.paneId ?? windowTarget,
      "-c",
      input.cwd,
      "-P",
      "-F",
      "#{pane_id}"
    ];
    if (input.command && input.command.length > 0) args.push(input.command.join(" "));
    const r = this.tmux(args, { timeout: 3000 });
    if (r.status !== 0) {
      throw new Error(commandFailureMessage(r, `tmux split-window failed (status ${r.status})`));
    }
    const paneId = r.stdout.trim();
    return {
      id: paneId, featureId: input.featureId,
      command: input.command ?? [], cwd: input.cwd,
      pid: null, status: "running",
      spawnedAt: new Date().toISOString()
    };
  }

  private resolveSpawnTarget(
    windowTarget: string,
    requestedPaneId?: string
  ): { paneId?: string; width: number; height: number } {
    const panes = this.listPaneGeometries(windowTarget);
    if (requestedPaneId) {
      const pane = panes.find((candidate) => candidate.paneId === requestedPaneId);
      if (!pane) throw new Error(`target pane ${requestedPaneId} is not in ${windowTarget}`);
      return pane;
    }
    return panes
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] ?? { width: 0, height: 0 };
  }

  private listPaneGeometries(windowTarget: string): Array<{ paneId: string; width: number; height: number }> {
    const fmt = ["#{pane_id}", "#{pane_width}", "#{pane_height}"].join(TMUX_FIELD_SEP);
    const r = this.tmux(["list-panes", "-t", windowTarget, "-F", fmt], { timeout: 1500 });
    if (r.status !== 0) return [];
    return r.stdout.split("\n").flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      const [paneId, width, height] = trimmed.split(TMUX_FIELD_SEP);
      if (!paneId) return [];
      return [{ paneId, width: Number(width) || 0, height: Number(height) || 0 }];
    });
  }

  async killPane(paneId: string): Promise<void> {
    this.tmux(["kill-pane", "-t", paneId], { timeout: 1500 });
  }

  async listPanes(featureId: string): Promise<Pane[]> {
    const feature = this.deps.featuresStore.getById(featureId);
    if (!feature) return [];
    const project = this.deps.projectsStore.getById(feature.projectId);
    if (!project) return [];
    const target = `${project.tmuxSessionName}:${feature.tmuxWindowName}`;
    const fmt = [
      "#{pane_id}",
      "#{pane_current_command}",
      "#{pane_current_path}",
      "#{pane_pid}",
      "#{pane_start_time}"
    ].join(TMUX_FIELD_SEP);
    const r = this.tmux(["list-panes", "-t", target, "-F", fmt], { timeout: 1500 });
    if (r.status !== 0) return [];
    const panes: Pane[] = [];
    for (const line of r.stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const [paneId, command, cwd, pidStr, startTime] = t.split(TMUX_FIELD_SEP);
      if (!paneId) continue;
      panes.push({
        id: paneId,
        featureId,
        command: command ? [command] : [],
        cwd: cwd ?? "",
        pid: pidStr ? Number(pidStr) : null,
        status: "running",
        spawnedAt: startTime ?? new Date().toISOString()
      });
    }
    return panes;
  }

  async getPane(paneId: string): Promise<Pane | null> {
    // Tmux pane lookup by id requires a target. We don't know the feature
    // from a bare paneId, so scan all active features.
    const projects = this.deps.projectsStore.listActive();
    for (const p of projects) {
      const features = this.deps.featuresStore.listActiveByProject(p.id);
      for (const f of features) {
        const panes = await this.listPanes(f.id);
        const found = panes.find((pp) => pp.id === paneId);
        if (found) return found;
      }
    }
    return null;
  }

  async sendKeys(paneId: string, args: string[]): Promise<void> {
    for (const arg of args) {
      if (arg === "--") break;
      if (arg === "-t" || arg.startsWith("-t") || arg === "--target-pane" || arg.startsWith("--target-pane=")) {
        throw new Error("tmux send-keys target is managed by Mandate; do not include -t/--target-pane in args");
      }
    }
    const r = this.tmux(["send-keys", "-t", paneId, ...args], { timeout: 1500 });
    if (r.status !== 0) {
      throw new Error(commandFailureMessage(r, `tmux send-keys failed (status ${r.status})`));
    }
  }

  async readScrollback(paneId: string, opts?: ReadScrollbackOptions): Promise<string> {
    const lines = opts?.tailLines ?? 200;
    const r = this.tmux(["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`], { timeout: 1500 });
    if (r.status !== 0) return "";
    return r.stdout;
  }

  async attachViewer(
    paneId: string,
    ws: WSContext,
    geometry: { cols: number; rows: number },
    options: { fit?: boolean; historyRows?: number } = {}
  ): Promise<ViewerHandle> {
    const initialHistoryRows = clampNumber(
      options.historyRows,
      MIN_INITIAL_HISTORY_ROWS,
      MAX_INITIAL_HISTORY_ROWS,
      DEFAULT_INITIAL_HISTORY_ROWS
    );

    // 1. If the browser already has Web fit enabled, acquire the fit lease
    // before the first capture. Otherwise the initial snapshot is taken at
    // the old tmux rows and the prompt lands halfway up the screen after the
    // later fit resize.
    if (options.fit) {
      const fit = this.fitManager.applyFit(paneId, ws, geometry);
      if (!fit) throw new Error("tmux fit failed");
    }

    // 2. Non-fit viewers can seed scrollback immediately. Web fit waits for
    // the resize to settle before sending the first authoritative snapshot;
    // an immediate capture after resize can briefly show stale history rows
    // before the TUI redraw catches up.
    if (!options.fit) {
      const initialCapture = capturePaneInitial(this.deps.tmuxClient, paneId, initialHistoryRows);
      if (initialCapture !== null) ws.send(initialCapture);
    }

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => {});

    let pipeAttached = false;
    const attachOutputPipe = () => {
      if (pipeAttached) return ready;
      pipeAttached = true;
      this.pipeManager.attachTerminalClient(paneId, ws).then(resolveReady, rejectReady);
      return ready;
    };

    let delayedFitRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const clearDelayedFitRefresh = () => {
      if (delayedFitRefreshTimer === null) return;
      clearTimeout(delayedFitRefreshTimer);
      delayedFitRefreshTimer = null;
    };
    if (options.fit) {
      // Full-screen TUIs process SIGWINCH asynchronously after tmux resize.
      // Sample tmux's visible grid until it stops changing, then send one
      // authoritative first frame and only then subscribe to live pipe bytes.
      // This hides the resize/repaint sequence Codex/Claude also visibly show
      // in native terminals.
      let previousCapture: string | null = null;
      let stableSamples = 0;
      const startedAt = Date.now();
      const sampleSettledFrame = () => {
        delayedFitRefreshTimer = null;
        if (ws.readyState !== WS_OPEN || !this.fitManager.hasClientLease(ws, paneId)) return;

        const visibleBytes = capturePaneRefresh(this.deps.tmuxClient, paneId);
        const timedOut = Date.now() - startedAt >= INITIAL_FIT_SETTLE_MAX_MS;
        stableSamples = visibleBytes !== null && visibleBytes === previousCapture ? stableSamples + 1 : 1;
        if (visibleBytes !== null && (timedOut || stableSamples >= INITIAL_FIT_STABLE_SAMPLES)) {
          const initialBytes = capturePaneRefresh(this.deps.tmuxClient, paneId, initialHistoryRows) ?? visibleBytes;
          if (ws.readyState === WS_OPEN) ws.send(initialBytes);
          attachOutputPipe();
          return;
        }

        previousCapture = visibleBytes;
        delayedFitRefreshTimer = setTimeout(sampleSettledFrame, INITIAL_FIT_SETTLE_SAMPLE_MS);
        delayedFitRefreshTimer.unref?.();
      };
      delayedFitRefreshTimer = setTimeout(sampleSettledFrame, INITIAL_FIT_SETTLE_FIRST_SAMPLE_MS);
      delayedFitRefreshTimer.unref?.();
    }

    // 3. Subscribe to the pane's shared output pipe. In Web fit we do this
    // only after the first settled capture; otherwise live resize/redraw bytes
    // can arrive first and expose the TUI's intermediate repaint sequence.
    //
    // The pipe broadcasts
    //    every tmux byte to every connected viewer for this pane. We do
    //    NOT await pipe.ready — that adds a 100-300ms gate on every attach
    //    where the handle isn't returned until tmux pipe-pane binds nc,
    //    which is user-perceptible as "terminal feels laggy on open" for
    //    active panes (claude / vim live output is gapped). Tests that need
    //    to fire sendKeys immediately after attach can compensate with a
    //    small delay (waitForPipeReady() helper or `await new Promise(...)`).
    if (!options.fit) attachOutputPipe();

    // NOTE: do NOT call applyFit here unless options.fit was explicitly set
    // above. A fit-lease must only be applied when the client explicitly
    // sends {type:"fit", enabled:true} from the "Fit browser" button.
    // Calling applyFit on every attach resizes + zooms the tmux window to
    // the browser's reported geometry on every viewer connect — invisible
    // in tests but causes weird widths in real use.
    // The geometry parameter is otherwise captured by the message handler in
    // case the client sends a "fit" later, but that's currently driven by the
    // payload itself.

    // Define the message handler. Hono's WSContext exposes no
    // addEventListener / on API — message dispatch is the dispatcher's
    // job (modules/panes/terminal-route.ts). It calls handleMessage on the
    // returned ViewerHandle for each browser→server frame.
    const onMessage = (data: unknown) => {
      this.handleClientMessage(paneId, ws, data);
    };

    return {
      ready,
      detach: () => {
        if (!pipeAttached) resolveReady();
        clearDelayedFitRefresh();
        this.clearFitSettleTimer(ws);
        this.fitManager.releaseClient(ws);
        this.pipeManager.detachTerminalClient(paneId, ws);
      },
      resize: (newGeo) => {
        // Only honor explicit resize requests from the viewer (the "fit"
        // path). Without an active lease this is a noop on tmux.
        this.fitManager.applyFit(paneId, ws, newGeo);
      },
      handleMessage: (data) => onMessage(data)
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Make sure the feature's session and window exist, rebuilding what is
   * missing. A no-op in the ordinary case — `hasSession`/`hasWindow` are two
   * cheap tmux queries — and only ever additive: nothing here removes or
   * replaces a live window.
   *
   * A feature Mandate does not own (`ownership !== "app"`) is left alone;
   * reconcile reports it broken rather than recreating someone else's window,
   * and the split below then fails with tmux's own message.
   */
  private ensureFeatureWindow(feature: FeatureRow, project: ProjectRow): void {
    const adapter = tmuxReconcileAdapter(this.deps.tmuxClient);
    reconcileProject(project, this.deps.featuresStore.listActiveByProject(project.id), adapter);
    reconcileFeature(feature, project, adapter);
  }

  private tmux(args: string[], options?: CommandRunOptions) {
    return tmuxCommand(this.deps.tmuxClient, args, options);
  }

  private clearFitSettleTimer(ws: WSContext): void {
    const timer = this.fitSettleTimers.get(ws);
    if (!timer) return;
    clearTimeout(timer);
    this.fitSettleTimers.delete(ws);
  }

  private scheduleSettledFrame(
    paneId: string,
    ws: WSContext,
    options: {
      requireFitLease?: boolean;
      onSettled?: () => void;
      onCancel?: () => void;
    } = {}
  ): void {
    this.clearFitSettleTimer(ws);

    let previousCapture: string | null = null;
    let stableSamples = 0;
    const startedAt = Date.now();
    const requireFitLease = options.requireFitLease ?? true;

    const sampleSettledFrame = () => {
      this.fitSettleTimers.delete(ws);
      if (ws.readyState !== WS_OPEN) {
        options.onCancel?.();
        return;
      }

      if (requireFitLease) {
        if (!this.fitManager.hasClientLease(ws, paneId)) {
          options.onCancel?.();
          return;
        }
      }

      const bytes = capturePaneRefresh(this.deps.tmuxClient, paneId);
      const timedOut = Date.now() - startedAt >= INITIAL_FIT_SETTLE_MAX_MS;
      stableSamples = bytes !== null && bytes === previousCapture ? stableSamples + 1 : 1;
      if (bytes !== null && (timedOut || stableSamples >= INITIAL_FIT_STABLE_SAMPLES)) {
        if (ws.readyState === WS_OPEN) ws.send(bytes);
        options.onSettled?.();
        return;
      }
      if (bytes === null && timedOut) {
        options.onCancel?.();
        return;
      }

      previousCapture = bytes;
      const timer = setTimeout(sampleSettledFrame, INITIAL_FIT_SETTLE_SAMPLE_MS);
      this.fitSettleTimers.set(ws, timer);
      timer.unref?.();
    };

    const timer = setTimeout(sampleSettledFrame, INITIAL_FIT_SETTLE_FIRST_SAMPLE_MS);
    this.fitSettleTimers.set(ws, timer);
    timer.unref?.();
  }

  private handleClientMessage(
    paneId: string,
    ws: WSContext,
    message: unknown
  ) {
    let payload: unknown;
    try {
      payload = JSON.parse(messageToString(message));
    } catch {
      return null;
    }

    if (!isRecord(payload)) return null;

    if (payload.type === "input" && typeof payload.data === "string") {
      this.sendInputBytes(paneId, payload.data);
      return { type: "input" };
    }
    if (payload.type === "fit") {
      if (payload.enabled === false) {
        this.pipeManager.pauseTerminalClientOutput(paneId, ws);
        this.fitManager.releaseClient(ws, true, 0);
        this.scheduleSettledFrame(paneId, ws, {
          requireFitLease: false,
          onSettled: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws),
          onCancel: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws)
        });
        return { type: "fit", enabled: false };
      }
      if (payload.enabled === true) {
        this.pipeManager.pauseTerminalClientOutput(paneId, ws);
        const fit = this.fitManager.applyFit(paneId, ws, terminalSizeFromPayload(payload));
        if (!fit) {
          this.pipeManager.resumeTerminalClientOutput(paneId, ws);
          return fit;
        }
        this.scheduleSettledFrame(paneId, ws, {
          onSettled: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws),
          onCancel: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws)
        });
        return fit;
      }
    }
    if (payload.type === "resize") {
      const size = terminalSizeFromPayload(payload);
      this.fitManager.resizeForClient(ws, paneId, size);
      return { type: "resize", size };
    }
    if (payload.type === "refresh") {
      this.pipeManager.resumeTerminalClientOutput(paneId, ws);
      this.pipeManager.rearmTerminalPipe(paneId);
      const bytes = capturePaneRefresh(this.deps.tmuxClient, paneId);
      if (bytes !== null && ws.readyState === WS_OPEN) ws.send(bytes);
      return { type: "refresh" };
    }
    return null;
  }

  private sendInputBytes(paneId: string, input: string) {
    const bytes = Buffer.from(input, "utf8");
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + INPUT_CHUNK_BYTES);
      const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0"));
      if (hex.length > 0) {
        const r = this.tmux(["send-keys", "-H", "-t", paneId, ...hex], { timeout: 1000 });
        if (r.status !== 0) {
          throw new Error(commandFailureMessage(r, `tmux send-keys literal input failed (status ${r.status})`));
        }
      }
    }
  }
}
