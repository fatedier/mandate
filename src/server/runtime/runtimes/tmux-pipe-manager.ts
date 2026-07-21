import type { WSContext } from "hono/ws";
import * as fs from "node:fs";
import * as path from "node:path";
import { logError } from "../../platform/logger.js";
import { type TmuxClient, tmuxCommand } from "../../platform/tmux/tmux.js";
import { commandFailureMessage, nodeCommandRunner } from "../../platform/process/command-runner.js";
import { WS_CONNECTING, WS_OPEN } from "./tmux-runtime-constants.js";
import { shellSingleQuote } from "./tmux-runtime-utils.js";

interface PanePipe {
  paneId: string;
  fifoPath: string;
  /** Read end of the fifo the current `cat` writes to. One reader per arm: a
   *  fifo read end sees EOF once its writer exits and cannot be reused after
   *  that, so re-arming opens a fresh one. */
  source: fs.ReadStream | null;
  clients: Set<WSContext>;
  pausedClients: Set<WSContext>;
  closing: boolean;
  arming: boolean;
  rearmTimer: ReturnType<typeof setTimeout> | null;
  ready: Promise<void>;
}

const PIPE_REARM_DELAY_MS = 100;

/** `.sock` is what pipes were named while they were unix sockets fed by
 *  `nc -U`. A process that starts after an upgrade still has to clean up
 *  whatever the pre-upgrade process left behind. */
const PIPE_SUFFIXES = [".fifo", ".sock"] as const;

export class TmuxPipeManager {
  private readonly activePipes = new Map<string, PanePipe>();

  constructor(
    private readonly options: {
      tmuxClient: TmuxClient;
      pipeDir: string;
      pipePrefix: string;
    }
  ) {}

  sweepStalePipes(): void {
    let entries: string[] = [];
    try { entries = fs.readdirSync(this.options.pipeDir); } catch { return; }
    const paneIdsToStop = new Set<string>();
    for (const entry of entries) {
      if (!entry.startsWith("mandate-pipe-")) continue;
      const suffix = PIPE_SUFFIXES.find((candidate) => entry.endsWith(candidate));
      if (!suffix) continue;
      if (entry.startsWith(`${this.options.pipePrefix}-`)) continue;
      const stripped = entry.slice("mandate-pipe-".length, -suffix.length);
      const parts = stripped.split("-");
      if (parts.length >= 3) {
        const paneIdSafe = parts.slice(1, -1).join("-");
        const paneId = paneIdSafe.replace(/^_/, "%");
        paneIdsToStop.add(paneId);
      }
      try { fs.unlinkSync(path.join(this.options.pipeDir, entry)); } catch { /* ignore */ }
    }
    for (const paneId of paneIdsToStop) {
      tmuxCommand(this.options.tmuxClient, ["pipe-pane", "-t", paneId], { timeout: 1000 });
    }
  }

  disposeAll(): void {
    for (const pipe of this.activePipes.values()) this.disposePanePipe(pipe, 500);
    this.activePipes.clear();
  }

  attachTerminalClient(paneId: string, ws: WSContext): Promise<void> {
    const existing = this.activePipes.get(paneId);
    const pipe = this.ensurePanePipe(paneId);
    pipe.clients.add(ws);
    if (existing && pipe.source === null) this.schedulePipeRearm(pipe, PIPE_REARM_DELAY_MS);
    return pipe.ready;
  }

  rearmTerminalPipe(paneId: string): boolean {
    const pipe = this.activePipes.get(paneId);
    if (!pipe || pipe.closing || pipe.source !== null) return false;
    this.schedulePipeRearm(pipe, 0);
    return true;
  }

  private ensurePanePipe(paneId: string): PanePipe {
    const existing = this.activePipes.get(paneId);
    if (existing && !existing.closing) {
      return existing;
    }

    const fifoPath = this.pipeFifoPath(paneId);
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const pipe: PanePipe = {
      paneId,
      fifoPath,
      source: null,
      clients: new Set(),
      pausedClients: new Set(),
      closing: false,
      arming: false,
      rearmTimer: null,
      ready
    };

    this.activePipes.set(paneId, pipe);

    const made = nodeCommandRunner.run("mkfifo", [fifoPath], { timeout: 1000 });
    if (made.status !== 0) {
      const err = new Error(commandFailureMessage(made, `mkfifo failed (status ${made.status})`));
      logError(`terminal pipe ${paneId}`, err, "could not create pipe fifo");
      this.closePipeClients(pipe, 1011, "pipe fifo failed");
      this.disposePanePipe(pipe);
      rejectReady(err);
      return pipe;
    }

    const result = this.armTmuxPipe(pipe);
    if (result.status !== 0 && !pipe.closing) {
      this.closePipeClients(pipe, 1011, "tmux pipe-pane failed");
      this.disposePanePipe(pipe);
      rejectReady(new Error("tmux pipe-pane failed"));
      return pipe;
    }
    resolveReady();

    return pipe;
  }

  detachTerminalClient(paneId: string, ws: WSContext): void {
    const pipe = this.activePipes.get(paneId);
    if (!pipe) return;
    pipe.clients.delete(ws);
    pipe.pausedClients.delete(ws);
    if (pipe.clients.size === 0) {
      this.disposePanePipe(pipe);
    }
  }

  pauseTerminalClientOutput(paneId: string, ws: WSContext): void {
    const pipe = this.activePipes.get(paneId);
    if (!pipe || !pipe.clients.has(ws)) return;
    pipe.pausedClients.add(ws);
  }

  resumeTerminalClientOutput(paneId: string, ws: WSContext): void {
    const pipe = this.activePipes.get(paneId);
    if (!pipe) return;
    pipe.pausedClients.delete(ws);
  }

  private schedulePipeRearm(pipe: PanePipe, delayMs: number): void {
    if (pipe.closing || pipe.arming || pipe.rearmTimer !== null || pipe.clients.size === 0) return;
    pipe.rearmTimer = setTimeout(() => {
      pipe.rearmTimer = null;
      if (pipe.closing || pipe.arming || pipe.clients.size === 0 || pipe.source !== null) return;
      const result = this.armTmuxPipe(pipe);
      if (result.status !== 0 && !pipe.closing) {
        logError(
          `terminal pipe ${pipe.paneId}`,
          new Error(commandFailureMessage(result, `tmux pipe-pane rearm failed (status ${result.status})`)),
          "tmux pipe-pane rearm failed"
        );
      }
    }, delayMs);
    pipe.rearmTimer.unref?.();
  }

  private armTmuxPipe(pipe: PanePipe) {
    pipe.arming = true;
    try {
      const result = tmuxCommand(
        this.options.tmuxClient,
        [
          "pipe-pane",
          "-O",
          "-t",
          pipe.paneId,
          `exec cat > ${shellSingleQuote(pipe.fifoPath)}`
        ],
        { timeout: 1000 }
      );
      if (result.status === 0 && !pipe.closing) this.openPipeSource(pipe);
      return result;
    } finally {
      pipe.arming = false;
    }
  }

  /** Opens the read end, and only ever after the arm. `cat` is already blocked
   *  opening the write end by the time this runs, so the open returns at once;
   *  opening first would block here instead, and a fifo open waiting for its
   *  peer cannot be cancelled. */
  private openPipeSource(pipe: PanePipe): void {
    if (pipe.source !== null) return;
    const source = fs.createReadStream(pipe.fifoPath);
    pipe.source = source;

    source.on("data", (chunk: Buffer) => {
      if (pipe.closing) return;
      const view = new Uint8Array(chunk.byteLength);
      view.set(chunk);
      for (const client of pipe.clients) {
        if (pipe.pausedClients.has(client)) continue;
        if (client.readyState === WS_OPEN) client.send(view);
      }
    });

    // EOF here means the `cat` this reader was opened for is gone — which is
    // exactly what tmux leaves behind when a pipe is stopped, since stopping a
    // pipe closes the command's stdin rather than killing it.
    const detachSource = () => {
      if (pipe.source !== source) return;
      pipe.source = null;
      if (!pipe.closing && pipe.clients.size > 0) {
        this.schedulePipeRearm(pipe, PIPE_REARM_DELAY_MS);
      }
    };
    source.on("error", () => {
      source.destroy();
      detachSource();
    });
    source.on("end", detachSource);
    source.on("close", detachSource);
  }

  private pipeFifoPath(paneId: string): string {
    const safe = paneId.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(this.options.pipeDir, `${this.options.pipePrefix}-${safe}-${Date.now()}.fifo`);
  }

  private closePipeClients(pipe: PanePipe, code: number, reason: string): void {
    for (const client of pipe.clients) {
      if (client.readyState === WS_OPEN || client.readyState === WS_CONNECTING) {
        try { client.close(code, reason); } catch { /* ignore */ }
      }
    }
    pipe.clients.clear();
    pipe.pausedClients.clear();
  }

  private disposePanePipe(pipe: PanePipe, timeout = 1000): void {
    if (pipe.closing) return;
    pipe.closing = true;
    if (pipe.rearmTimer !== null) {
      clearTimeout(pipe.rearmTimer);
      pipe.rearmTimer = null;
    }
    if (this.activePipes.get(pipe.paneId) === pipe) {
      this.activePipes.delete(pipe.paneId);
      this.stopTmuxPipe(pipe.paneId, timeout);
    }
    const source = pipe.source;
    pipe.source = null;
    if (source) {
      // A read end still waiting for its writer sits inside open(2) and cannot
      // be destroyed out from under itself. Opening the write end for a moment
      // releases it and hands it the EOF it needs to finish closing.
      try {
        const fd = fs.openSync(pipe.fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        fs.closeSync(fd);
      } catch { /* nothing was waiting, or the fifo is already gone */ }
      try { source.destroy(); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(pipe.fifoPath); } catch { /* ignore */ }
  }

  private stopTmuxPipe(paneId: string, timeout = 1000): void {
    try {
      tmuxCommand(this.options.tmuxClient, ["pipe-pane", "-t", paneId], { timeout });
    } catch { /* ignore */ }
  }
}
