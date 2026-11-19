import type { WSContext } from "hono/ws";
import * as fs from "node:fs";
import * as path from "node:path";
import { logError } from "../../platform/logger.js";
import { Mutex } from "async-mutex";
import { type TmuxClient, tmuxCommand } from "../../platform/tmux/tmux.js";
import { commandFailureMessage, nodeCommandRunner, type CommandRunner } from "../../platform/process/command-runner.js";
import { WS_CONNECTING, WS_OPEN } from "./tmux-runtime-constants.js";
import { shellSingleQuote } from "../../platform/process/shell-snapshot.js";

interface PanePipe {
  paneId: string;
  fifoPath: string;
  /** Read end of the fifo the current `cat` writes to. One reader per arm: a
   *  fifo read end sees EOF once its writer exits and cannot be reused after
   *  that, so re-arming opens a fresh one. */
  source: fs.ReadStream | null;
  clients: Set<WSContext>;
  pausedClients: Set<WSContext>;
  /** Viewers whose bytes are kept, not sent, while their paint is taken:
   *  sent after it, in order. */
  heldOutput: Map<WSContext, Uint8Array<ArrayBuffer>[]>;
  closing: boolean;
  arming: boolean;
  rearmTimer: ReturnType<typeof setTimeout> | null;
  /** Settles once bytes flow: the first arm, or after the read end ended, the
   *  next one (or the pipe's take-down). A viewer is painted only then. */
  ready: Promise<void>;
  /** Settles `ready` while it waits for a re-arm. */
  settleRearm: (() => void) | null;
}

const PIPE_REARM_DELAY_MS = 100;

const PIPE_SUFFIX = ".fifo";

/**
 * Each pane's output, piped by tmux (`pipe-pane`) through a fifo to every
 * viewer of it. Setting a pipe up, re-arming it and taking it down are each a
 * few commands and files changed together, so they run alone, one after
 * another in the order asked: tmux answers while the server goes on. What a
 * step decided on before its turn (a pipe with no viewer left, one needing a
 * re-arm) is asked again when its turn comes.
 */
export class TmuxPipeManager {
  private readonly activePipes = new Map<string, PanePipe>();
  /** Viewers sent nothing until unmuted (muteTerminalClient). */
  private readonly mutedClients = new Set<WSContext>();
  private readonly ops = new Mutex();
  /** Shut down: no pipe is set up, re-armed or taken down in turn any more. */
  private closed = false;

  constructor(
    private readonly options: {
      tmuxClient: TmuxClient;
      pipeDir: string;
      pipePrefix: string;
      /** What runs mkfifo; tests give their own. */
      fifoRunner?: CommandRunner;
    }
  ) {}

  private fifoRunner(): CommandRunner {
    return this.options.fifoRunner ?? nodeCommandRunner;
  }

  /** A fifo made after its pipe was taken down (or shutdown came) while
   *  mkfifo ran: its maker removes it, as nothing else will. */
  private takenDownMeanwhile(pipe: PanePipe): boolean {
    if (!pipe.closing && !this.closed) return false;
    try { fs.unlinkSync(pipe.fifoPath); } catch { /* not made */ }
    return true;
  }

  /** Clears fifos left by Mandate processes that are gone, and stops their
   *  panes' pipes. Another live Mandate on the same machine
   *  shares the temp dir and the tmux server: its fifos are
   *  in use, and removing one silenced its terminals. */
  sweepStalePipes(): Promise<void> {
    return this.ops.runExclusive(() => this.sweepStalePipesNow());
  }

  private async sweepStalePipesNow(): Promise<void> {
    let entries: string[] = [];
    try { entries = fs.readdirSync(this.options.pipeDir); } catch { return; }
    const paneIdsToStop = new Set<string>();
    for (const entry of entries) {
      if (!entry.startsWith("mandate-pipe-")) continue;
      if (!entry.endsWith(PIPE_SUFFIX)) continue;
      if (entry.startsWith(`${this.options.pipePrefix}-`)) continue;
      const stripped = entry.slice("mandate-pipe-".length, -PIPE_SUFFIX.length);
      const parts = stripped.split("-");
      if (processAlive(Number(parts[0]))) continue;
      if (parts.length >= 3) {
        const paneIdSafe = parts.slice(1, -1).join("-");
        const paneId = paneIdSafe.replace(/^_/, "%");
        paneIdsToStop.add(paneId);
      }
      try { fs.unlinkSync(path.join(this.options.pipeDir, entry)); } catch { /* ignore */ }
    }
    for (const paneId of paneIdsToStop) {
      await tmuxCommand(this.options.tmuxClient, ["pipe-pane", "-t", paneId], { timeout: 1000 });
    }
  }

  /** Shutdown has little time (the container gives it 500 ms): what is local
   *  goes first and at once — streams closed, fifos removed — whatever tmux
   *  does, then tmux is told to stop every pipe, side by side. Work still
   *  waiting its turn is dropped. */
  async disposeAll(): Promise<void> {
    this.closed = true;
    const pipes = [...this.activePipes.values()].filter((pipe) => !pipe.closing);
    for (const pipe of pipes) this.takeDownLocally(pipe);
    this.activePipes.clear();
    await Promise.all(pipes.map((pipe) => this.stopTmuxPipe(pipe.paneId, 500)));
  }

  attachTerminalClient(paneId: string, ws: WSContext): Promise<void> {
    const existing = this.activePipes.get(paneId);
    const pipe = this.ensurePanePipe(paneId);
    pipe.clients.add(ws);
    if (existing === pipe && pipe.source === null) this.schedulePipeRearm(pipe, PIPE_REARM_DELAY_MS);
    return pipe.ready;
  }

  /** Work on the pipes, in turn; a failure is logged, never thrown, and none
   *  runs once shut down. */
  private inTurn(label: string, work: () => Promise<void>): void {
    void this.ops.runExclusive(() => (this.closed ? undefined : work()))
      .catch((err: unknown) => logError(`terminal pipe ${label}`, err, "pipe work failed"));
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
      heldOutput: new Map(),
      closing: false,
      arming: false,
      rearmTimer: null,
      ready,
      settleRearm: null
    };

    if (this.closed) {
      // Shut down: a viewer that comes now gets no pipe.
      pipe.closing = true;
      resolveReady();
      return pipe;
    }
    this.activePipes.set(paneId, pipe);
    void this.ops.runExclusive(async () => {
      // Taken down (or shut down) before its turn came: nothing to set up.
      if (pipe.closing || this.closed) return resolveReady();
      const made = await this.fifoRunner().run("mkfifo", [fifoPath], { timeout: 1000 });
      if (this.takenDownMeanwhile(pipe)) return resolveReady();
      if (made.status !== 0) {
        const err = new Error(commandFailureMessage(made, `mkfifo failed (status ${made.status})`));
        logError(`terminal pipe ${paneId}`, err, "could not create pipe fifo");
        this.closePipeClients(pipe, 1011, "pipe fifo failed");
        await this.disposePanePipe(pipe);
        return rejectReady(err);
      }
      const result = await this.armTmuxPipe(pipe);
      if (result.status !== 0 && !pipe.closing) {
        this.closePipeClients(pipe, 1011, "tmux pipe-pane failed");
        await this.disposePanePipe(pipe);
        return rejectReady(new Error("tmux pipe-pane failed"));
      }
      // Taken down while tmux armed it (a shutdown): tmux is told to stop it
      // again, or its `cat` waits on a fifo nobody will open.
      if (result.status === 0 && pipe.closing) await this.stopTmuxPipe(paneId, 500);
      resolveReady();
    }).catch((err: unknown) => {
      logError(`terminal pipe ${paneId}`, err, "pipe setup failed");
      rejectReady(err instanceof Error ? err : new Error(String(err)));
    });

    return pipe;
  }

  detachTerminalClient(paneId: string, ws: WSContext): void {
    this.mutedClients.delete(ws);
    const pipe = this.activePipes.get(paneId);
    if (!pipe) return;
    pipe.clients.delete(ws);
    pipe.pausedClients.delete(ws);
    pipe.heldOutput.delete(ws);
    if (pipe.clients.size === 0) {
      // Taken down in turn, and only if still nobody's: a viewer may have
      // come to this pane meanwhile.
      this.inTurn(paneId, async () => {
        if (this.activePipes.get(paneId) === pipe && pipe.clients.size === 0) await this.disposePanePipe(pipe);
      });
    }
  }

  /** Sends the viewer nothing, held or live, until unmuted, whatever pauses
   *  and holds come and go meanwhile: a fitted viewer whose window another
   *  pane's viewer took, as its pane's bytes no longer fit its screen. Its
   *  screen stays as it was until it fits again, which paints it. */
  muteTerminalClient(ws: WSContext): void {
    this.mutedClients.add(ws);
  }

  unmuteTerminalClient(ws: WSContext): void {
    this.mutedClients.delete(ws);
  }

  isTerminalClientMuted(ws: WSContext): boolean {
    return this.mutedClients.has(ws);
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

  /** Keeps the viewer's bytes instead of sending them, from now until
   *  released: what the pane writes while its paint is being taken. */
  holdTerminalClientOutput(paneId: string, ws: WSContext): void {
    const pipe = this.activePipes.get(paneId);
    if (!pipe || !pipe.clients.has(ws) || pipe.heldOutput.has(ws)) return;
    pipe.heldOutput.set(ws, []);
  }

  /** Sends what was kept for the viewer, after its paint, and its live bytes
   *  from then on; a pause ends with it. */
  releaseTerminalClientOutput(paneId: string, ws: WSContext): void {
    const pipe = this.activePipes.get(paneId);
    if (!pipe) return;
    const held = pipe.heldOutput.get(ws);
    pipe.heldOutput.delete(ws);
    pipe.pausedClients.delete(ws);
    if (held && ws.readyState === WS_OPEN && !this.mutedClients.has(ws)) for (const chunk of held) ws.send(chunk);
  }

  private schedulePipeRearm(pipe: PanePipe, delayMs: number): void {
    if (pipe.closing || pipe.arming || pipe.rearmTimer !== null || pipe.clients.size === 0) return;
    pipe.rearmTimer = setTimeout(() => {
      pipe.rearmTimer = null;
      this.inTurn(pipe.paneId, async () => {
        if (pipe.closing || pipe.arming || pipe.clients.size === 0 || pipe.source !== null) return;
        const fifo = await this.ensureFifo(pipe.fifoPath);
        if (this.takenDownMeanwhile(pipe)) return;
        if (!fifo) {
          logError(`terminal pipe ${pipe.paneId}`, new Error("mkfifo failed"), "could not make the pipe fifo again");
          // No bytes will flow: a viewer waiting for them is painted anyway.
          pipe.settleRearm?.();
          return;
        }
        const result = await this.armTmuxPipe(pipe);
        if (result.status === 0 && pipe.closing) await this.stopTmuxPipe(pipe.paneId, 500);
        if (result.status !== 0 && !pipe.closing) {
          logError(
            `terminal pipe ${pipe.paneId}`,
            new Error(commandFailureMessage(result, `status ${result.status}`)),
            "tmux pipe-pane rearm failed"
          );
        }
      });
    }, delayMs);
    pipe.rearmTimer.unref?.();
  }

  private async armTmuxPipe(pipe: PanePipe) {
    pipe.arming = true;
    try {
      const result = await tmuxCommand(
        this.options.tmuxClient,
        [
          "pipe-pane",
          "-O",
          "-t",
          pipe.paneId,
          // Only into the fifo: removed meanwhile (a shutdown, a temp
          // cleaner), `>` would make a plain file there that nobody reads or
          // removes; the command ends instead, and a re-arm makes the fifo again.
          `[ -p '${shellSingleQuote(pipe.fifoPath)}' ] && exec cat > '${shellSingleQuote(pipe.fifoPath)}'`
        ],
        { timeout: 1000 }
      );
      if (result.status === 0 && !pipe.closing) this.openPipeSource(pipe);
      return result;
    } finally {
      pipe.arming = false;
      // Armed, or the arm failed (logged; a viewer is painted anyway).
      pipe.settleRearm?.();
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
        if (this.mutedClients.has(client)) continue;
        const held = pipe.heldOutput.get(client);
        if (held) {
          held.push(view);
          continue;
        }
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
      if (pipe.closing) return;
      this.awaitRearm(pipe);
      if (pipe.clients.size > 0) this.schedulePipeRearm(pipe, PIPE_REARM_DELAY_MS);
    };
    source.on("error", () => {
      source.destroy();
      detachSource();
    });
    source.on("end", detachSource);
    source.on("close", detachSource);
  }

  /** No bytes flow until the next arm: a viewer that comes meanwhile waits
   *  for it, or what the pane writes between its paint and the re-arm would
   *  reach it nowhere. */
  private awaitRearm(pipe: PanePipe): void {
    if (pipe.settleRearm) return;
    let settle!: () => void;
    pipe.ready = new Promise<void>((resolve) => { settle = resolve; });
    pipe.settleRearm = () => {
      pipe.settleRearm = null;
      settle();
    };
  }

  private pipeFifoPath(paneId: string): string {
    const safe = paneId.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(this.options.pipeDir, `${this.options.pipePrefix}-${safe}-${Date.now()}${PIPE_SUFFIX}`);
  }

  private closePipeClients(pipe: PanePipe, code: number, reason: string): void {
    for (const client of pipe.clients) {
      if (client.readyState === WS_OPEN || client.readyState === WS_CONNECTING) {
        try { client.close(code, reason); } catch { /* ignore */ }
      }
    }
    pipe.clients.clear();
    pipe.pausedClients.clear();
    pipe.heldOutput.clear();
  }

  /** What is local goes at once (a shutdown meanwhile finds nothing left
   *  of it), then tmux is told to stop the pipe. */
  private async disposePanePipe(pipe: PanePipe, timeout = 1000): Promise<void> {
    if (pipe.closing) return;
    const wasActive = this.activePipes.get(pipe.paneId) === pipe;
    this.takeDownLocally(pipe);
    if (wasActive) await this.stopTmuxPipe(pipe.paneId, timeout);
  }

  /** The pipe's own side, at once: its re-arm, its read end and its fifo. */
  private takeDownLocally(pipe: PanePipe): void {
    pipe.closing = true;
    pipe.settleRearm?.();
    if (pipe.rearmTimer !== null) {
      clearTimeout(pipe.rearmTimer);
      pipe.rearmTimer = null;
    }
    if (this.activePipes.get(pipe.paneId) === pipe) this.activePipes.delete(pipe.paneId);
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

  /** The fifo at `fifoPath`, made again if something removed it (a temp
   *  cleaner) or left a plain file there: `cat >` a missing path writes a
   *  regular file nobody reads, and the terminal goes silent. */
  private async ensureFifo(fifoPath: string): Promise<boolean> {
    try {
      if (fs.statSync(fifoPath).isFIFO()) return true;
      fs.unlinkSync(fifoPath);
    } catch { /* missing */ }
    return (await this.fifoRunner().run("mkfifo", [fifoPath], { timeout: 1000 })).status === 0;
  }

  private async stopTmuxPipe(paneId: string, timeout = 1000): Promise<void> {
    try {
      await tmuxCommand(this.options.tmuxClient, ["pipe-pane", "-t", paneId], { timeout });
    } catch { /* ignore */ }
  }
}

/** Whether a process exists (EPERM: it does, as another user's). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
