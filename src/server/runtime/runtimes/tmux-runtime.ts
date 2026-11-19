import type { WSContext } from "hono/ws";
import * as os from "node:os";
import type {
  Pane, ViewerHandle,
  SpawnPaneInput, ReadScrollbackOptions
} from "../pane-runtime.js";
import { type TmuxClient, tmuxCommand } from "../../platform/tmux/tmux.js";
import { createKeyedExclusion } from "../../platform/process/keyed-exclusion.js";
import { logError } from "../../platform/logger.js";
import {
  commandDidNotAnswer,
  CommandDidNotAnswerError,
  commandFailureMessage,
  type CommandRunOptions
} from "../../platform/process/command-runner.js";
import type { ProjectsStore } from "../../modules/projects/projects-store.js";
import type { WorkersStore } from "../../modules/workers/workers-store.js";
import type { WorkerRow } from "../../modules/workers/workers-store.js";
import type { ProjectRow } from "../../modules/projects/projects-store.js";
import { reconcileWorker, reconcileProject } from "../../modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../../modules/projects/tmux-reconcile-adapter.js";
import {
  DEFAULT_INITIAL_HISTORY_ROWS,
  INITIAL_FIT_SETTLE_FIRST_SAMPLE_MS,
  INITIAL_FIT_SETTLE_MAX_MS,
  INITIAL_FIT_SETTLE_SAMPLE_MS,
  INPUT_CHUNK_BYTES,
  MAX_INITIAL_HISTORY_ROWS,
  MIN_INITIAL_HISTORY_ROWS,
  TMUX_FIELD_SEP,
  WS_OPEN,
  ACTIVE_TERMINAL_CHECK_MS,
  GIVEN_BACK_PAINT_MS
} from "./tmux-runtime-constants.js";
import { FitSettle } from "./tmux-fit-settle.js";
import { TmuxFitManager } from "./tmux-fit-manager.js";
import { TmuxPipeManager } from "./tmux-pipe-manager.js";
import { capturePaneInitial, capturePaneRefresh, capturePaneRows } from "./tmux-terminal-capture.js";
import {
  clampNumber,
  messageToString,
  terminalSizeFromPayload,
  type TerminalGeometry
} from "./tmux-runtime-utils.js";
import { isRecord } from "../../../shared/guards.js";

interface TmuxRuntimeDeps {
  tmuxClient: TmuxClient;
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
  /** Optional notifier called when a tmux window's geometry changes
   *  (apply-fit / release-fit / resize). The app container wires this to
   *  `poller.poll({ forceWindowIds: [id] })` so snapshot freshness is
   *  immediate instead of waiting up to pollIntervalMs. */
  onWindowChanged?: (windowId: string) => void;
  fitRestoreGraceMs?: number;
  activeTerminalCheckMs?: number;
}

/** A message to the viewer itself, not pane output: a text frame that
 *  starts with NUL, which a capture of a pane never does (the browser reads
 *  it as a control, in order with what the socket sends around it). Sent
 *  past a mute: a muted viewer is still told. */
function sendTerminalControl(ws: WSContext, message: { type: "given-back"; cols?: number; rows?: number }): void {
  if (ws.readyState === WS_OPEN) ws.send(`\u0000${JSON.stringify(message)}`);
}

function splitDirectionForTarget(target: { width: number; height: number }): "right" | "down" {
  const visualWidth = Math.max(0, target.width) * 0.56;
  const visualHeight = Math.max(0, target.height);
  return visualWidth >= visualHeight ? "right" : "down";
}

export class TmuxRuntime {
  private readonly fitSettleTimers = new Map<WSContext, ReturnType<typeof setTimeout>>();
  /** Each fitted viewer's size, as it last asked: a viewer whose window
   *  another took takes it back at this size when it types. */
  private readonly fitSizes = new Map<WSContext, TerminalGeometry>();
  /** Fitted viewers on Auto: a terminal on their window used after them
   *  takes it back. */
  private readonly fitAuto = new Set<WSContext>();
  private activeTerminalCheck: ReturnType<typeof setInterval> | null = null;
  /** Viewers given back whose output waits for them to take the pane's size
   *  and let go (their fit:false); painted anyway when that does not come. */
  private readonly givenBack = new Map<WSContext, ReturnType<typeof setTimeout>>();
  /** Each viewer's newest settled-frame run: an older one whose paint is
   *  still waiting its turn gives way. */
  private readonly settleRuns = new Map<WSContext, number>();
  /**
   * Each pane's turn: what is typed into it (by any viewer or agent), each
   * viewer's frames, a viewer's hand-over to live bytes (its first paint,
   * then its pipe armed) and a repaint run one at a time, in the order they
   * came. tmux answers while the server goes on; in this one order a paste
   * and its Enter are never split by another sender, and nothing typed runs
   * between a paint being taken and the live bytes that follow it.
   */
  private readonly paneWork = createKeyedExclusion();
  /** Shutting down: a step still waiting its turn does nothing. */
  private closing = false;

  /** A step in the pane's turn whose failure is logged, not thrown. */
  private inPaneTurn(paneId: string, step: () => Promise<unknown> | unknown, what: string): Promise<void> {
    return this.paneWork.run(paneId, () => (this.closing ? undefined : step()))
      .then(() => undefined, (err: unknown) => logError(`terminal ${paneId}`, err, what));
  }
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
      restoreDelayMs: deps.fitRestoreGraceMs,
      onFitTaken: (ws) => this.pipeManager.muteTerminalClient(ws),
      onFitReturned: (ws, paneId) => this.fitReturned(paneId, ws)
    });
    this.pipeManager = new TmuxPipeManager({
      tmuxClient: deps.tmuxClient,
      pipeDir: this.pipeDir,
      pipePrefix: this.pipePrefix
    });
  }

  /** Server boot: sweep stale pipes and fit leases. */
  async init(): Promise<void> {
    await this.pipeManager.sweepStalePipes();
    await this.fitManager.sweepStaleFitLeases();
    this.activeTerminalCheck = setInterval(() => { void this.giveBackToUsedTerminals(); }, this.deps.activeTerminalCheckMs ?? ACTIVE_TERMINAL_CHECK_MS);
    this.activeTerminalCheck.unref?.();
  }

  /** Windows held for viewers on Auto that a terminal on them was used on
   *  since go back to it. Each of those viewers is told so, with the pane's
   *  size, on its own socket (a control frame, ahead of anything after it),
   *  and painted once it has taken that size: muted until its let-go, sent
   *  after it resized, so nothing is drawn at the size it had; without one
   *  in GIVEN_BACK_PAINT_MS it is painted anyway. */
  private async giveBackToUsedTerminals(): Promise<void> {
    if (this.closing) return;
    let yielded: Array<{ ws: WSContext; paneId: string; size: TerminalGeometry | null }>;
    try {
      // Sent nothing from the first change on (muted: no live bytes, no
      // held ones, no paint; a paint of its fit still settling stops), so
      // what the pane redraws as the window is put back is not drawn at the
      // size they had; their let-go (or the fallback) makes it theirs again.
      yielded = await this.fitManager.yieldToActiveClients((holders) => {
        for (const ws of holders) {
          this.pipeManager.muteTerminalClient(ws);
          this.clearFitSettleTimer(ws);
          this.settleRuns.set(ws, (this.settleRuns.get(ws) ?? 0) + 1);
        }
      });
    } catch (err: unknown) {
      logError("terminal", err, "giving windows back failed");
      return;
    }
    for (const { ws, paneId, size } of yielded) {
      sendTerminalControl(ws, { type: "given-back", ...(size ? { cols: size.cols, rows: size.rows } : {}) });
      this.fitSizes.delete(ws);
      this.fitAuto.delete(ws);
      const paintAnyway = setTimeout(() => {
        if (this.givenBack.get(ws) !== paintAnyway) return;
        this.givenBack.delete(ws);
        void this.inPaneTurn(paneId, () => this.paintAsItsOwn(paneId, ws), "repaint after giving the window back failed");
      }, GIVEN_BACK_PAINT_MS);
      paintAnyway.unref?.();
      this.givenBack.set(ws, paintAnyway);
    }
  }

  /** Its pane's bytes its own again, from a paint of the pane as it is. */
  private paintAsItsOwn(paneId: string, ws: WSContext): void {
    this.pipeManager.unmuteTerminalClient(ws);
    this.scheduleSettledFrame(paneId, ws, {
      requireFitLease: false,
      onSettled: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws),
      onCancel: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws)
    });
  }

  private forgetGivenBack(ws: WSContext): void {
    const timer = this.givenBack.get(ws);
    if (timer) clearTimeout(timer);
    this.givenBack.delete(ws);
  }

  /** Server shutdown. */
  async dispose(): Promise<void> {
    // Runs on shutdown: SIGTERM/SIGINT/SIGHUP call container.dispose(),
    // which calls this.
    // The container gives this 500 ms: nothing new starts, and the fit leases
    // and the pipes are put back and taken down side by side.
    this.closing = true;
    if (this.activeTerminalCheck) clearInterval(this.activeTerminalCheck);
    for (const timer of this.givenBack.values()) clearTimeout(timer);
    this.givenBack.clear();
    for (const timer of this.fitSettleTimers.values()) clearTimeout(timer);
    this.fitSettleTimers.clear();
    await Promise.all([this.fitManager.restoreAll(), this.pipeManager.disposeAll()]);
  }

  async spawnPane(input: SpawnPaneInput): Promise<Pane> {
    const worker = this.deps.workersStore.getById(input.workerId);
    if (!worker) throw new Error(`worker ${input.workerId} not found`);
    const project = this.deps.projectsStore.getById(worker.projectId);
    if (!project) throw new Error(`project ${worker.projectId} not found`);
    // Read when the split's turn comes: an archived worker's window, rebuilt
    // below, would be left open with no worker to close it.
    if (worker.archivedAt || project.archivedAt) throw new Error(`worker ${input.workerId} is archived`);
    const cwd = input.cwd ?? worker.worktreePath ?? project.workingDir;

    // Splitting needs a window to split. When the worker's window has gone,
    // rebuild it first — the same reconcile the Create pane button runs before
    // it reaches here.
    //
    // Without this the two are not the same operation: the button recovers a
    // vanished window and the agent's `spawn_pane` only ever answers "can't
    // find window", so the one action that would unblock the worker is
    // reachable from the UI and from nowhere else. An agent that cannot see
    // the second path has nothing left but to wait for someone to take it.
    await this.ensureWorkerWindow(worker, project);

    const windowTarget = `${project.tmuxSessionName}:${worker.tmuxWindowName}`;
    const target = await this.resolveSpawnTarget(windowTarget, input.targetPaneId);
    const direction = input.direction ?? splitDirectionForTarget(target);
    const args = [
      "split-window",
      direction === "right" ? "-h" : "-v",
      "-d",
      "-t",
      target.paneId ?? windowTarget,
      "-c",
      cwd,
      "-P",
      "-F",
      "#{pane_id}"
    ];
    if (input.command && input.command.length > 0) args.push(input.command.join(" "));
    const r = await this.tmux(args, { timeout: 3000 });
    if (r.status !== 0) {
      throw new Error(commandFailureMessage(r, `tmux split-window failed (status ${r.status})`));
    }
    const paneId = r.stdout.trim();
    return {
      id: paneId, workerId: input.workerId,
      command: input.command ?? [], cwd,
      pid: null,
      spawnedAt: new Date().toISOString()
    };
  }

  private async resolveSpawnTarget(
    windowTarget: string,
    requestedPaneId?: string
  ): Promise<{ paneId?: string; width: number; height: number }> {
    const panes = await this.listPaneGeometries(windowTarget);
    if (requestedPaneId) {
      const pane = panes.find((candidate) => candidate.paneId === requestedPaneId);
      if (!pane) throw new Error(`target pane ${requestedPaneId} is not in ${windowTarget}`);
      return pane;
    }
    return panes
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] ?? { width: 0, height: 0 };
  }

  private async listPaneGeometries(windowTarget: string): Promise<Array<{ paneId: string; width: number; height: number }>> {
    const fmt = ["#{pane_id}", "#{pane_width}", "#{pane_height}"].join(TMUX_FIELD_SEP);
    const r = await this.tmux(["list-panes", "-t", windowTarget, "-F", fmt], { timeout: 1500 });
    if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-panes");
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
    await this.tmux(["kill-pane", "-t", paneId], { timeout: 1500 });
  }

  async listPanes(workerId: string): Promise<Pane[]> {
    const worker = this.deps.workersStore.getById(workerId);
    if (!worker) return [];
    const project = this.deps.projectsStore.getById(worker.projectId);
    if (!project) return [];
    const target = `${project.tmuxSessionName}:${worker.tmuxWindowName}`;
    const fmt = [
      "#{pane_id}",
      "#{pane_current_command}",
      "#{pane_current_path}",
      "#{pane_pid}",
      "#{pane_start_time}"
    ].join(TMUX_FIELD_SEP);
    const r = await this.tmux(["list-panes", "-t", target, "-F", fmt], { timeout: 1500 });
    if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-panes");
    if (r.status !== 0) return [];
    const panes: Pane[] = [];
    for (const line of r.stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const [paneId, command, cwd, pidStr, startTime] = t.split(TMUX_FIELD_SEP);
      if (!paneId) continue;
      panes.push({
        id: paneId,
        workerId,
        command: command ? [command] : [],
        cwd: cwd ?? "",
        pid: pidStr ? Number(pidStr) : null,
        spawnedAt: startTime ?? new Date().toISOString()
      });
    }
    return panes;
  }

  async sendKeys(paneId: string, args: string[]): Promise<void> {
    for (const arg of args) {
      if (arg === "--") break;
      if (arg === "-t" || arg.startsWith("-t") || arg === "--target-pane" || arg.startsWith("--target-pane=")) {
        throw new Error("tmux send-keys target is managed by Mandate; do not include -t/--target-pane in args");
      }
    }
    await this.paneWork.run(paneId, async () => {
      const r = await this.tmux(["send-keys", "-t", paneId, ...args], { timeout: 1500 });
      if (r.status !== 0) {
        throw new Error(commandFailureMessage(r, `tmux send-keys failed (status ${r.status})`));
      }
    });
  }

  async readScrollback(paneId: string, opts?: ReadScrollbackOptions): Promise<string> {
    const lines = opts?.tailLines ?? 200;
    const r = await this.tmux(["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`], { timeout: 1500 });
    if (r.status !== 0) return "";
    return r.stdout;
  }

  /** The handle comes back at once, before tmux is asked anything: from the
   *  first frame on, what the viewer sends takes its place in the pane's turn
   *  as it comes, behind the attach's own steps. */
  attachViewer(
    paneId: string,
    ws: WSContext,
    geometry: { cols: number; rows: number },
    options: { fit?: boolean; auto?: boolean; resume?: boolean; historyRows?: number } = {}
  ): ViewerHandle {
    const initialHistoryRows = clampNumber(
      options.historyRows,
      MIN_INITIAL_HISTORY_ROWS,
      MAX_INITIAL_HISTORY_ROWS,
      DEFAULT_INITIAL_HISTORY_ROWS
    );

    // Gone, the viewer stops every sample and step still on its way.
    let detached = false;

    // Settles once the viewer is handed over: its first paint sent and its
    // pipe live (or the pipe failed), or once it went.
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => {});

    const inTurn = (step: () => Promise<unknown> | unknown, what: string): Promise<void> =>
      this.inPaneTurn(paneId, () => (detached ? undefined : step()), what);

    let pipeLive: Promise<void> | null = null;
    const attachOutputPipe = () => {
      pipeLive ??= this.pipeManager.attachTerminalClient(paneId, ws);
      return pipeLive;
    };
    const handedOver = (live: Promise<void>) => live.then(resolveReady, rejectReady);
    // As every paint: the viewer is on the pane's pipe, its bytes kept, and
    // the pipe live (a new one is armed first, perhaps after other panes'
    // pipe work) before its first paint is taken; the bytes are sent after
    // the paint, so what the pane writes meanwhile, on its own as well as
    // from input, reaches neither nowhere nor ahead of the paint. A pipe
    // that failed still lets the paint go; `ready` then says it failed.
    const joinPipeHeld = () => {
      const live = attachOutputPipe();
      this.pipeManager.holdTerminalClientOutput(paneId, ws);
      return live;
    };

    // 2. The hand-over to live bytes, one step in the pane's turn: the pipe
    // live, then the first paint. What is typed before it shows in the paint;
    // what is typed after waits for the hand-over, so it never echoes into
    // the gap between the two. Without a fit it runs at once, seeding
    // scrollback; with one it waits for the resize to settle, as an
    // immediate capture after a resize can briefly show stale rows before the
    // TUI redraw catches up.
    // In the pane's turn: the first paint at the pane's own size.
    const paintAtPaneSize = async () => {
      const live = joinPipeHeld();
      try {
        await live.catch(() => {});
        if (detached) return;
        const initialCapture = await capturePaneInitial(this.deps.tmuxClient, paneId, initialHistoryRows);
        if (detached) return;
        if (initialCapture !== null && ws.readyState === WS_OPEN) ws.send(initialCapture);
      } finally {
        this.pipeManager.releaseTerminalClientOutput(paneId, ws);
      }
      await handedOver(live);
    };
    if (!options.fit) void inTurn(paintAtPaneSize, "first paint failed");

    let delayedFitRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const clearDelayedFitRefresh = () => {
      if (delayedFitRefreshTimer === null) return;
      clearTimeout(delayedFitRefreshTimer);
      delayedFitRefreshTimer = null;
    };
    if (options.fit) {
      // 1. With Web fit already on in the browser, the fit lease comes first,
      // in the pane's turn: taken after the first capture, the snapshot would
      // be at the old tmux rows and the prompt land halfway up the screen
      // after the later fit resize.
      //
      // Full-screen TUIs process SIGWINCH asynchronously after tmux resize.
      // Sample tmux's visible grid until it settles (FitSettle), then hand over:
      // one authoritative first frame and only then live pipe bytes. This
      // hides the resize/repaint sequence Codex/Claude also visibly show in
      // native terminals.
      const settle = new FitSettle();
      let startedAt = Date.now();
      const stillHere = () => !detached && !this.closing && ws.readyState === WS_OPEN;
      const fitted = () => this.fitManager.hasClientLease(ws, paneId);
      // Handed over with its first paint; without one when another pane's
      // viewer took the window first: it is sent nothing then until it fits
      // again, which paints it (TmuxPipeManager.muteTerminalClient).
      const handOver = (paint: boolean) => {
        void inTurn(async () => {
          if (!stillHere()) return;
          const live = joinPipeHeld();
          try {
            await live.catch(() => {});
            if (!stillHere()) return;
            if (paint && fitted()) {
              const initialBytes = await capturePaneRefresh(this.deps.tmuxClient, paneId, initialHistoryRows);
              if (!stillHere()) return;
              // Taken meanwhile: its screen stays as it is.
              if (initialBytes !== null && !this.pipeManager.isTerminalClientMuted(ws)) ws.send(initialBytes);
            }
          } finally {
            this.pipeManager.releaseTerminalClientOutput(paneId, ws);
          }
          await handedOver(live);
        }, "first paint failed");
      };
      const sampleSettledFrame = async () => {
        delayedFitRefreshTimer = null;
        if (!stillHere()) return;
        if (!fitted()) return handOver(false);

        const rows = await capturePaneRows(this.deps.tmuxClient, paneId);
        if (!stillHere()) return;
        if (!fitted()) return handOver(false);
        if (settle.sample(rows, Date.now() - startedAt)) {
          handOver(true);
          return;
        }

        delayedFitRefreshTimer = setTimeout(sample, INITIAL_FIT_SETTLE_SAMPLE_MS);
        delayedFitRefreshTimer.unref?.();
      };
      const sample = () => { sampleSettledFrame().catch((err: unknown) => logError(`terminal ${paneId}`, err, "settled frame failed")); };
      this.fitSizes.set(ws, geometry);
      if (options.auto) this.fitAuto.add(ws);
      void inTurn(async () => {
        // `resume`: asked by a socket come back on Auto, not by the terminal
        // used; decided here, ahead of the first paint.
        const fit = await this.fitManager.applyFit(paneId, ws, geometry, { auto: options.auto === true, resume: options.resume === true });
        if (detached) return;
        if (!fit) {
          ws.close(1011, "tmux fit failed");
          return;
        }
        if (fit.type === "given-back") {
          // Not fitted: told so first, then painted at the pane's size.
          this.fitSizes.delete(ws);
          this.fitAuto.delete(ws);
          sendTerminalControl(ws, { type: "given-back", ...(fit.size ? { cols: fit.size.cols, rows: fit.size.rows } : {}) });
          await paintAtPaneSize();
          return;
        }
        startedAt = Date.now();
        delayedFitRefreshTimer = setTimeout(sample, INITIAL_FIT_SETTLE_FIRST_SAMPLE_MS);
        delayedFitRefreshTimer.unref?.();
      }, "fit failed");
    }

    // 3. The pipe broadcasts every tmux byte to every connected viewer for
    //    this pane. The handle does NOT wait for pipe.ready — that adds a
    //    100-300ms gate on every attach where the handle isn't returned until
    //    tmux pipe-pane starts its command, which is user-perceptible as
    //    "terminal feels laggy on open" for active panes. Tests that need live
    //    output before typing await `ready`.

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
    // Each frame takes its place in the pane's turn as it comes, so a
    // viewer's frames keep their order and what anyone types keeps the order
    // it was sent in.
    // A frame received is the viewer's word even if it goes before its turn
    // comes: what it typed still reaches the pane, the rest no longer applies.
    const onMessage = (data: unknown): Promise<void> =>
      this.inPaneTurn(paneId, () => this.handleClientMessage(paneId, ws, data, () => detached), "terminal message failed");

    return {
      ready,
      detach: () => {
        detached = true;
        resolveReady();
        clearDelayedFitRefresh();
        this.clearFitSettleTimer(ws);
        this.settleRuns.delete(ws);
        this.fitSizes.delete(ws);
        this.fitAuto.delete(ws);
        this.forgetGivenBack(ws);
        void this.fitManager.releaseClient(ws).catch((err: unknown) => logError(`terminal ${paneId}`, err, "fit release failed"));
        this.pipeManager.detachTerminalClient(paneId, ws);
      },
      resize: (newGeo) => {
        // Only honor explicit resize requests from the viewer (the "fit"
        // path). Without an active lease this is a noop on tmux.
        void this.fitManager.applyFit(paneId, ws, newGeo).catch((err: unknown) => logError(`terminal ${paneId}`, err, "fit failed"));
      },
      handleMessage: (data) => onMessage(data)
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Make sure the worker's session and window exist, rebuilding what is
   * missing. A no-op in the ordinary case — `hasSession`/`hasWindow` are two
   * cheap tmux queries — and only ever additive: nothing here removes or
   * replaces a live window.
   *
   * A worker Mandate does not own (`ownership !== "app"`) is left alone;
   * reconcile reports it broken rather than recreating someone else's window,
   * and the split below then fails with tmux's own message.
   */
  private async ensureWorkerWindow(worker: WorkerRow, project: ProjectRow): Promise<void> {
    const adapter = tmuxReconcileAdapter(this.deps.tmuxClient);
    await reconcileProject(project, this.deps.workersStore.listActiveByProject(project.id), adapter);
    await reconcileWorker(worker, project, adapter);
  }

  private tmux(args: string[], options?: CommandRunOptions) {
    return tmuxCommand(this.deps.tmuxClient, args, options);
  }

  /** Its window given back (TmuxFitManager): its own bytes again, from a
   *  paint of the pane at its size on. */
  private fitReturned(paneId: string, ws: WSContext): void {
    this.pipeManager.unmuteTerminalClient(ws);
    this.pipeManager.pauseTerminalClientOutput(paneId, ws);
    this.scheduleSettledFrame(paneId, ws, {
      onSettled: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws),
      onCancel: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws)
    });
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
    const run = (this.settleRuns.get(ws) ?? 0) + 1;
    this.settleRuns.set(ws, run);

    const settle = new FitSettle();
    const startedAt = Date.now();
    const requireFitLease = options.requireFitLease ?? true;

    const gone = () => ws.readyState !== WS_OPEN || (requireFitLease && !this.fitManager.hasClientLease(ws, paneId));
    // A newer run (another fit change) owns the viewer's timer and its
    // resume: an older one stops where it stands, touching neither.
    const current = () => !this.closing && this.settleRuns.get(ws) === run;
    const sampleSettledFrame = async () => {
      if (!current()) return;
      this.fitSettleTimers.delete(ws);
      if (gone()) {
        options.onCancel?.();
        return;
      }

      const rows = await capturePaneRows(this.deps.tmuxClient, paneId);
      // Asked again: the viewer may have gone, or a newer run started, while tmux answered.
      if (!current()) return;
      if (gone()) {
        options.onCancel?.();
        return;
      }
      const timedOut = Date.now() - startedAt >= INITIAL_FIT_SETTLE_MAX_MS;
      if (settle.sample(rows, Date.now() - startedAt)) {
        // The paint, in the pane's turn: what is typed waits for it, and what
        // the pane writes while it is taken is kept and sent after it.
        void this.inPaneTurn(paneId, async () => {
          if (!current()) return;
          if (gone()) {
            this.pipeManager.releaseTerminalClientOutput(paneId, ws);
            options.onCancel?.();
            return;
          }
          this.pipeManager.holdTerminalClientOutput(paneId, ws);
          try {
            const paint = await capturePaneRefresh(this.deps.tmuxClient, paneId);
            if (paint !== null && ws.readyState === WS_OPEN && !this.pipeManager.isTerminalClientMuted(ws)) ws.send(paint);
          } finally {
            this.pipeManager.releaseTerminalClientOutput(paneId, ws);
          }
          options.onSettled?.();
        }, "settled frame failed");
        return;
      }
      if (rows === null && timedOut) {
        options.onCancel?.();
        return;
      }

      const timer = setTimeout(sample, INITIAL_FIT_SETTLE_SAMPLE_MS);
      this.fitSettleTimers.set(ws, timer);
      timer.unref?.();
    };
    const sample = () => { sampleSettledFrame().catch((err: unknown) => logError(`terminal ${paneId}`, err, "settled frame failed")); };

    const timer = setTimeout(sample, INITIAL_FIT_SETTLE_FIRST_SAMPLE_MS);
    this.fitSettleTimers.set(ws, timer);
    timer.unref?.();
  }

  private async handleClientMessage(
    paneId: string,
    ws: WSContext,
    message: unknown,
    gone: () => boolean
  ) {
    let payload: unknown;
    try {
      payload = JSON.parse(messageToString(message));
    } catch {
      return null;
    }

    if (!isRecord(payload)) return null;
    if (gone() && payload.type !== "input") return null;

    if (payload.type === "input" && typeof payload.data === "string") {
      // Typed into a fitted viewer whose window another pane's viewer took:
      // the user is typing here, so the window comes back first and what is
      // typed shows, rather than going into the pane unseen.
      // Not for one on Auto: its terminal answers its pane through input with
      // no one at it, and its browser asks for its fit, ahead of the keys,
      // when it is used.
      const size = !gone() && this.pipeManager.isTerminalClientMuted(ws) && !this.fitAuto.has(ws) ? this.fitSizes.get(ws) : undefined;
      if (size) await this.takeFit(paneId, ws, size, false);
      // Not counted as using it on Auto: the terminal answers its pane's
      // queries (cursor position, its kind) through input with no one at it.
      // The browser says when it was used (its fit asked again).
      await this.sendInputBytes(paneId, payload.data);
      return { type: "input" };
    }
    if (payload.type === "fit") {
      if (payload.enabled === false) {
        this.fitSizes.delete(ws);
        this.fitAuto.delete(ws);
        // Given back, it has taken the pane's size: its paint comes now.
        this.forgetGivenBack(ws);
        this.pipeManager.pauseTerminalClientOutput(paneId, ws);
        // `grace`: a terminal hidden behind another tab lets go; the one
        // shown may take the same window at once, which then is not put
        // back in between.
        await this.fitManager.releaseClient(ws, true, payload.grace === true ? undefined : 0);
        // No longer fitted, its pane's bytes are its own again.
        this.pipeManager.unmuteTerminalClient(ws);
        this.scheduleSettledFrame(paneId, ws, {
          requireFitLease: false,
          onSettled: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws),
          onCancel: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws)
        });
        return { type: "fit", enabled: false };
      }
      if (payload.enabled === true) {
        const size = terminalSizeFromPayload(payload);
        const auto = payload.auto === true;
        this.fitSizes.set(ws, size);
        if (auto) this.fitAuto.add(ws);
        else this.fitAuto.delete(ws);
        return this.takeFit(paneId, ws, size, auto);
      }
    }
    if (payload.type === "resize") {
      const size = terminalSizeFromPayload(payload);
      if (this.fitSizes.has(ws)) this.fitSizes.set(ws, size);
      await this.fitManager.resizeForClient(ws, paneId, size);
      return { type: "resize", size };
    }
    if (payload.type === "refresh") {
      this.pipeManager.unmuteTerminalClient(ws);
      this.pipeManager.resumeTerminalClientOutput(paneId, ws);
      this.pipeManager.rearmTerminalPipe(paneId);
      // What the pane writes while the paint is taken is sent after it, not
      // ahead of it, where the paint would clear it.
      this.pipeManager.holdTerminalClientOutput(paneId, ws);
      try {
        const bytes = await capturePaneRefresh(this.deps.tmuxClient, paneId);
        if (bytes !== null && ws.readyState === WS_OPEN && !this.pipeManager.isTerminalClientMuted(ws)) ws.send(bytes);
      } finally {
        this.pipeManager.releaseTerminalClientOutput(paneId, ws);
      }
      return { type: "refresh" };
    }
    return null;
  }

  /** The window fitted to this viewer at `size`, painted for it when that
   *  changed anything; in the pane's turn. */
  private async takeFit(paneId: string, ws: WSContext, size: TerminalGeometry, auto: boolean) {
    let paused = false;
    const fit = await this.fitManager.applyFit(paneId, ws, size, {
      auto,
      // Asked again by the viewer holding it, at its size (a terminal kept
      // behind another tab, shown again): nothing changes, nothing to paint.
      keep: true,
      beforeChange: () => {
        paused = true;
        this.pipeManager.pauseTerminalClientOutput(paneId, ws);
      }
    });
    // Given back only to a resume, which a frame never asks.
    if (!fit || fit.type !== "fit") {
      if (paused) this.pipeManager.resumeTerminalClientOutput(paneId, ws);
      return fit;
    }
    if (fit.kept) return fit;
    // Its own again: the pause holds its bytes back until the paint.
    this.pipeManager.unmuteTerminalClient(ws);
    this.scheduleSettledFrame(paneId, ws, {
      onSettled: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws),
      onCancel: () => this.pipeManager.resumeTerminalClientOutput(paneId, ws)
    });
    return fit;
  }

  /** Runs in the pane's turn (a viewer's frame), so never takes it. */
  private async sendInputBytes(paneId: string, input: string): Promise<void> {
    const bytes = Buffer.from(input, "utf8");
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + INPUT_CHUNK_BYTES);
      const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0"));
      if (hex.length > 0) {
        const r = await this.tmux(["send-keys", "-H", "-t", paneId, ...hex], { timeout: 1000 });
        if (r.status !== 0) {
          throw new Error(commandFailureMessage(r, `tmux send-keys literal input failed (status ${r.status})`));
        }
      }
    }
  }
}
