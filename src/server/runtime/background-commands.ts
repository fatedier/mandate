import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentStore, AgentWakeReason } from "../modules/agent/agent-store.js";
import type { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import { toolOutputDir, type ResourceOwner } from "../platform/fs/resources.js";
import { newId } from "../platform/ids.js";
import { logError } from "../platform/logger.js";
import type { ShellCommandRunner, ShellProcess, ShellProcessExit } from "../platform/process/shell-command-runner.js";
import { readOutputTail, type OutputTail } from "../platform/process/output-tail.js";
import { SSE_EVENTS, type BackgroundTaskDto, type BackgroundTaskStoppedBy } from "../../shared/api-contracts.js";
import {
  COMMAND_LIMITS,
  CommandLimitReached,
  commandResultMetadata,
  formatCommandResultText,
  type CommandLimits,
  type CommandOutcome
} from "../../shared/command-messages.js";

/** A running command as the server counts it. */
export interface CommandStats {
  bytes: number;
  lines: number;
  lastLine: string;
}

/** The end of a command's output as the model reads it. */
export type CommandTail = OutputTail;

export interface BackgroundCommandService {
  /** run_in_background: spawns the command and records it running. Throws
   *  the limit's text when the conversation already runs its limit. */
  start(input: { parentThreadId: string; command: string; title: string; cwd: string; owner: ResourceOwner }): Promise<BackgroundTaskDto>;
  /** A foreground call's process, handed over at its timeout, with its
   *  output so far and when it started (its clock runs from then). Refused
   *  (the limit's text, or a row the database keeps refusing), the process
   *  is killed. */
  adopt(input: { parentThreadId: string; command: string; title: string; owner: ResourceOwner; process: ShellProcess; soFar: Buffer; startedAt?: string }): Promise<BackgroundTaskDto>;
  /** Kills a running command with what it started; it ends stopped by `by`
   *  when its process does. Null for one not running here, or (requester
   *  given) another conversation's. */
  stop(taskId: string, by: BackgroundTaskStoppedBy, requesterThreadId?: string): BackgroundTaskDto | null;
  /** Every running command of a conversation archived or retired, stopped by
   *  "archive": nobody is told. */
  stopAllFor(parentThreadId: string): void;
  /** Stops, by "archive", every running command whose conversation is now
   *  archived, closed or retired, whatever path took it there (a project's
   *  archive, an agent's own write). The runtime calls it now and then. */
  sweep(): void;
  stats(taskId: string): CommandStats | null;
  /** The end of its output now: the last tailMaxLines lines within
   *  tailMaxBytes. Null when it has no output file left. */
  tail(taskId: string): CommandTail | null;
  /** At start-up: every command still recorded running is killed by its
   *  process group, ends interrupted, and its open conversation is told and
   *  woken. */
  recoverAtStartup(): void;
  /** The server stops: every running command's group is killed. Their rows
   *  stay running; the next start records them interrupted. */
  dispose(): void;
}

export interface BackgroundCommandDeps {
  /** A command's end and its result's mail are one write. */
  db: Database;
  tasks: BackgroundTaskStore;
  agentStore: AgentStore;
  sse: Pick<AgentSseEmitter, "emit">;
  runner: Pick<ShellCommandRunner, "spawn">;
  wake: (threadId: string, reason: AgentWakeReason, triggerMessageId: string | null) => string | null;
  /** The conversation's running set changed (the pending-monitor feed). */
  onTasksChanged?: (parentThreadId: string) => void;
  dataDir?: string;
  now?: () => Date;
  limits?: Partial<CommandLimits>;
  /** SIGKILL to a process group left by an earlier server; ESRCH ignored. */
  killGroup?: (pid: number) => void;
  /** When the machine booted, in ms: a group recorded before it is gone, and
   *  its id may be another's now. */
  bootTimeMs?: () => number;
  /** A thread retired with its feature: it starts nothing that outlives it. */
  isRetired?: (threadId: string) => boolean;
  /** How long a refused write waits before it is tried again, each time. */
  retryDelaysMs?: readonly number[];
}

interface Running {
  id: string;
  parentThreadId: string;
  outputPath: string;
  /** Its row is written. Until then its output is taken and its cap kept,
   *  but it is nobody's to stop by its id, and its end waits for the row. */
  recorded: boolean;
  /** How its process ended, once it has. */
  exit: ShellProcessExit | null;
  process: ShellProcess;
  /** The output file, appended to as the output comes; null once it failed. */
  fd: number | null;
  bytes: number;
  newlines: number;
  /** The last byte written was not a newline: one more line, unfinished. */
  unfinished: boolean;
  /** The unfinished line's first bytes, for the last line. */
  partial: Buffer;
  /** The last non-blank finished line. */
  lastFinished: string;
  lastLine: string;
  lastLiveAt: number;
  liveTimer: ReturnType<typeof setTimeout> | null;
  stopBy: BackgroundTaskStoppedBy | null;
  startedAt: number;
}

/** What is kept of a line for the live last line: enough bytes for its
 *  first LAST_LINE_CHARS characters. */
const LAST_LINE_BYTES = 1200;
const LAST_LINE_CHARS = 300;
const RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000];
/** How often a command's row is tried before its command is given up. */
const CREATE_ATTEMPTS = 5;
const STOPPED_BEFORE_START = "Stopped before it started.";
/** How long a killed command's group may still hold a member waiting for its
 *  SIGKILL (the runner sends it 2 s after the SIGTERM): the server's end
 *  sends it at once instead. */
const DYING_MS = 5000;

/** A command between its check and its row: it holds a slot, and an archive
 *  or the server's end cancels it. */
interface Pending {
  parentThreadId: string;
  child: ShellProcess | null;
  cancelled: boolean;
}

export function createBackgroundCommandService(deps: BackgroundCommandDeps): BackgroundCommandService {
  const limits: CommandLimits = { ...COMMAND_LIMITS, ...deps.limits };
  const running = new Map<string, Running>();
  const pending = new Set<Pending>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  const now = () => deps.now?.() ?? new Date();
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const killGroup = deps.killGroup ?? ((pid: number) => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  });
  const bootTimeMs = deps.bootTimeMs ?? (() => Date.now() - os.uptime() * 1000);
  const changed = (task: BackgroundTaskDto) => {
    deps.sse.emit(SSE_EVENTS.backgroundTaskChanged, { task });
    deps.onTasksChanged?.(task.parentThreadId);
  };
  const isOpen = (threadId: string) => {
    const thread = deps.agentStore.getThreadById(threadId);
    return Boolean(thread && !thread.archivedAt);
  };
  /** A conversation that may still hear of its commands: open, and not
   *  retired with its feature. */
  const listening = (threadId: string) => isOpen(threadId) && !deps.isRetired?.(threadId);
  const atomically = <T>(write: () => T): T => (deps.db.inTransaction ? write() : deps.db.transaction(write).immediate());
  /** Done again after a delay, until done: a write the database refused. */
  const later = (attempt: number, what: string, again: () => void) => {
    if (disposed) return;
    const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 1000;
    const timer = setTimeout(() => { timers.delete(timer); again(); }, delay);
    timer.unref?.();
    timers.add(timer);
    logError("background command", new Error(`${what}: tried again in ${delay} ms`));
  };
  const holdSlot = (parentThreadId: string, child: ShellProcess | null): Pending => {
    // Nothing starts for a conversation going away, or after the server's end.
    if (disposed || !listening(parentThreadId)) throw new Error(STOPPED_BEFORE_START);
    let held = 0;
    for (const slot of pending) if (slot.parentThreadId === parentThreadId) held++;
    if (deps.tasks.countRunning(parentThreadId, "command") + held >= limits.perThread) throw new CommandLimitReached(limits.perThread);
    const slot: Pending = { parentThreadId, child, cancelled: false };
    pending.add(slot);
    return slot;
  };
  const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });
  // Groups killed lately, by when: a member that ignores SIGTERM lives on
  // until the SIGKILL, which the server's end must not leave undone.
  const dying = new Map<number, number>();
  const kill = (child: ShellProcess) => {
    // After the server's end, at once: nothing is left to send the SIGKILL.
    if (disposed) {
      if (child.pid) killGroup(child.pid);
      return;
    }
    child.kill();
    const at = Date.now();
    for (const [pid, since] of dying) if (at - since >= DYING_MS) dying.delete(pid);
    if (child.pid) dying.set(child.pid, at);
  };

  const emitLive = (r: Running) => {
    r.lastLiveAt = Date.now();
    deps.sse.emit(SSE_EVENTS.backgroundTaskOutput, {
      taskId: r.id,
      parentThreadId: r.parentThreadId,
      lastLine: r.lastLine,
      bytes: r.bytes,
      lines: r.newlines + (r.unfinished ? 1 : 0)
    });
  };
  /** The live line: now when its interval has passed, else once when it does.
   *  None once it has ended: a grandchild still holding its pipe is not heard. */
  const live = (r: Running) => {
    if (r.liveTimer || running.get(r.id) !== r) return;
    const wait = r.lastLiveAt + limits.liveLineMs - Date.now();
    if (wait <= 0) {
      emitLive(r);
      return;
    }
    r.liveTimer = setTimeout(() => {
      r.liveTimer = null;
      if (running.get(r.id) === r) emitLive(r);
    }, wait);
    r.liveTimer.unref?.();
  };

  const take = (r: Running, chunk: Buffer) => {
    // Killed for its output: what it prints until it dies is not kept.
    if (chunk.length === 0 || r.stopBy === "output") return;
    if (r.fd !== null) {
      try {
        // A short write (a disk filling up) writes the rest; one that makes
        // no progress fails.
        for (let at = 0; at < chunk.length;) {
          const written = fs.writeSync(r.fd, chunk, at, chunk.length - at);
          if (written <= 0) throw new Error("the output file takes no more");
          at += written;
        }
      } catch (err) {
        logError(`background command ${r.id}: its output file failed; the rest is not kept`, err);
        closeFd(r);
      }
    }
    r.bytes += chunk.length;
    // Byte by byte: a search per newline cost ~9 s a GB of blank lines.
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) r.newlines++;
    r.unfinished = chunk[chunk.length - 1] !== 10;
    r.lastLine = lastLineOf(r, chunk);
    if (r.bytes > limits.outputMaxBytes && !r.stopBy) {
      r.stopBy = "output";
      kill(r.process);
    }
    if (r.recorded) live(r);
  };

  /** Its output from now on, into its file; its end, once its row is written. */
  const takeOver = (r: Running, child: ShellProcess, soFar: Buffer | null) => {
    try {
      r.fd = fs.openSync(r.outputPath, "a", 0o600);
    } catch (err) {
      logError(`background command ${r.id}: could not open its output file`, err);
    }
    if (soFar?.length) take(r, soFar);
    child.onOutput((chunk) => take(r, chunk));
    void child.exited.then((exit) => {
      r.exit = exit;
      // Not recorded yet: its end is read when its row is written (begin).
      if (r.recorded) ended(r, exit);
      else closeFd(r);
    });
  };

  /** Records a running command and takes it over. Its output is taken at
   *  once, its cap kept, while a row the database refuses is tried again;
   *  refused every time, or cancelled meanwhile, the command is killed and its
   *  file removed: unrecorded, nothing would ever stop it. */
  const begin = async (
    input: { parentThreadId: string; command: string; title: string; owner: ResourceOwner; startedAt?: string },
    slot: Pending,
    child: ShellProcess,
    soFar: Buffer | null
  ): Promise<BackgroundTaskDto> => {
    let r: Running | null = null;
    try {
      const id = newId("task");
      const dir = toolOutputDir({ owner: input.owner, threadId: input.parentThreadId, dataDir: deps.dataDir });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const startedAt = input.startedAt ? new Date(input.startedAt) : now();
      r = {
        id, parentThreadId: input.parentThreadId, outputPath: path.join(dir, `${id}.log`), recorded: false, exit: null,
        process: child, fd: null, bytes: 0, newlines: 0, unfinished: false, partial: Buffer.alloc(0),
        lastFinished: "", lastLine: "", lastLiveAt: 0, liveTimer: null, stopBy: null, startedAt: startedAt.getTime()
      };
      takeOver(r, child, soFar);
      for (let attempt = 1; ; attempt++) {
        if (slot.cancelled || disposed || !listening(input.parentThreadId)) throw new Error(STOPPED_BEFORE_START);
        let task: BackgroundTaskDto;
        try {
          task = deps.tasks.createCommand({
            id,
            parentThreadId: input.parentThreadId,
            title: input.title,
            command: input.command,
            outputPath: r.outputPath,
            pid: child.pid,
            startedAt: startedAt.toISOString()
          });
        } catch (err) {
          if (attempt >= CREATE_ATTEMPTS) throw err;
          logError(`background command: its row was refused (try ${attempt} of ${CREATE_ATTEMPTS})`, err);
          await pause(retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 1000);
          continue;
        }
        r.recorded = true;
        running.set(id, r);
        // Its row counts it now.
        pending.delete(slot);
        changed(task);
        // It ended, or printed, while its row was written.
        if (r.exit) ended(r, r.exit);
        else if (r.bytes > 0) live(r);
        return task;
      }
    } catch (err) {
      kill(child);
      if (r) {
        try { fs.unlinkSync(r.outputPath); } catch { /* none */ }
      }
      throw err;
    }
  };

  /** A parent with a result in its mail is woken for it; one the database
   *  refused to wake is woken again later. */
  const wakeParent = (parentThreadId: string, attempt = 0): void => {
    if (disposed || !deps.agentStore.queuedMailboxSources(parentThreadId).includes("command-result")) return;
    try {
      deps.wake(parentThreadId, "command-result", null);
    } catch (err) {
      logError(`background command: could not wake ${parentThreadId}`, err);
      later(attempt, `wake ${parentThreadId}`, () => wakeParent(parentThreadId, attempt + 1));
    }
  };

  // Ends whose write was refused, until it is done: an archive still silences them.
  const unwritten = new Map<string, End>();

  /** Records a command's end and, unless nobody is to be told, its result in
   *  its conversation's mail, in one write; a refused write is done again. */
  const record = (end: End, attempt = 0): void => {
    if (disposed) return;
    let written: { ended: BackgroundTaskDto; told: boolean } | null;
    try {
      written = atomically(() => {
        const ended = deps.tasks.finishCommand(end.taskId, {
          status: end.status,
          ...(end.stoppedBy ? { stoppedBy: end.stoppedBy } : {}),
          exitCode: end.exitCode,
          outputLines: end.tail.totalLines,
          reply: end.tail.text || null,
          error: end.error,
          at: now().toISOString()
        });
        if (!ended) return null;
        const told = end.tell && listening(ended.parentThreadId);
        if (told) {
          deps.agentStore.enqueueMailboxMessage({
            threadId: ended.parentThreadId,
            role: "user",
            source: "command-result",
            content: {
              type: "text",
              // What the model reads, in full: the wake-message adapter adds nothing.
              text: formatCommandResultText({
                title: ended.title, outcome: end.outcome, exitCode: end.exitCode, signal: end.signal, durationMs: end.durationMs,
                tail: end.tail.text, shownLines: end.tail.shownLines, totalLines: end.tail.totalLines, outputPath: ended.outputPath ?? ""
              }),
              // What the result line draws; it never reads the text.
              metadata: commandResultMetadata({
                taskId: ended.id, title: ended.title, outcome: end.outcome, exitCode: end.exitCode, signal: end.signal,
                durationMs: end.durationMs, outputLines: end.tail.totalLines
              })
            }
          });
        }
        return { ended, told };
      });
    } catch (err) {
      logError(`background command ${end.taskId}: its end was refused`, err);
      unwritten.set(end.taskId, end);
      later(attempt, `record the end of ${end.taskId}`, () => record(end, attempt + 1));
      return;
    }
    unwritten.delete(end.taskId);
    if (!written) return;
    changed(written.ended);
    if (written.told) wakeParent(written.ended.parentThreadId);
  };

  /** Its process ended: how, read with its output's end. */
  const ended = (r: Running, exit: ShellProcessExit) => {
    if (running.get(r.id) !== r) return;
    running.delete(r.id);
    if (r.liveTimer) clearTimeout(r.liveTimer);
    closeFd(r);
    if (disposed) return;
    const by = r.stopBy;
    const status = by ? "stopped" : exit.code === 0 ? "finished" : "failed";
    const outcome: CommandOutcome = by === "output" ? "output" : by ? "user" : exit.code !== null ? "exited" : "signal";
    const totalLines = r.newlines + (r.unfinished ? 1 : 0);
    record({
      taskId: r.id,
      parentThreadId: r.parentThreadId,
      status,
      stoppedBy: by,
      exitCode: by ? null : exit.code,
      error: status !== "failed" ? null : exit.code !== null ? `exit ${exit.code}` : `signal ${exit.signal ?? "unknown"}`,
      outcome,
      signal: exit.signal,
      // Its own agent stopped it and knows; an archive leaves nobody to tell.
      tell: !by || by === "user" || by === "output",
      // An output that cannot be read keeps what is known of it.
      tail: readOutputTail(r.outputPath, limits, totalLines) ?? { text: "", shownLines: 0, totalLines, bytes: r.bytes },
      durationMs: Math.max(0, now().getTime() - r.startedAt)
    });
  };

  const stop = (taskId: string, by: BackgroundTaskStoppedBy, requesterThreadId?: string): BackgroundTaskDto | null => {
    const r = running.get(taskId);
    if (!r || (requesterThreadId !== undefined && r.parentThreadId !== requesterThreadId)) return null;
    // The first reason stands (one killed for its output stays so), but an
    // archive silences whatever came before: nobody is left to tell.
    if (by === "archive") r.stopBy = "archive";
    else r.stopBy ??= by;
    kill(r.process);
    return deps.tasks.get(taskId);
  };

  return {
    async start(input) {
      const slot = holdSlot(input.parentThreadId, null);
      try {
        const child = await deps.runner.spawn(input.command, { cwd: input.cwd });
        if (!child) throw new Error(STOPPED_BEFORE_START);
        slot.child = child;
        return await begin(input, slot, child, null);
      } finally {
        pending.delete(slot);
      }
    },

    async adopt(input) {
      let slot: Pending;
      try {
        slot = holdSlot(input.parentThreadId, input.process);
      } catch (err) {
        kill(input.process);
        throw err;
      }
      try {
        return await begin(input, slot, input.process, input.soFar);
      } finally {
        pending.delete(slot);
      }
    },

    stop,

    stopAllFor(parentThreadId) {
      for (const slot of pending) {
        if (slot.parentThreadId !== parentThreadId) continue;
        slot.cancelled = true;
        if (slot.child) kill(slot.child);
      }
      for (const r of [...running.values()]) {
        if (r.parentThreadId === parentThreadId) stop(r.id, "archive");
      }
      for (const end of unwritten.values()) {
        if (end.parentThreadId === parentThreadId) end.tell = false;
      }
    },

    sweep() {
      for (const slot of pending) {
        if (slot.cancelled || listening(slot.parentThreadId)) continue;
        slot.cancelled = true;
        if (slot.child) kill(slot.child);
      }
      for (const r of [...running.values()]) {
        if (!listening(r.parentThreadId)) stop(r.id, "archive");
      }
    },

    stats(taskId) {
      const r = running.get(taskId);
      return r ? { bytes: r.bytes, lines: r.newlines + (r.unfinished ? 1 : 0), lastLine: r.lastLine } : null;
    },

    tail(taskId) {
      const r = running.get(taskId);
      if (r) return readOutputTail(r.outputPath, limits, r.newlines + (r.unfinished ? 1 : 0));
      const task = deps.tasks.get(taskId);
      // Its count as recorded at its end: a file of up to 1 GB is not counted again.
      return task?.kind === "command" ? readOutputTail(task.outputPath, limits, deps.tasks.outputLinesOf(taskId)) : null;
    },

    recoverAtStartup() {
      const booted = bootTimeMs();
      for (const task of deps.tasks.listOpen("command")) {
        if (running.has(task.id)) continue;
        // One that cannot be put right does not keep the others from it.
        try {
          const startedAt = Date.parse(task.startedAt ?? task.createdAt);
          // A group recorded before the machine booted is gone, and its id may
          // be another's by now.
          const pid = deps.tasks.pidOf(task.id);
          // Never pid 1 or below: such a group id reaches every process of the user.
          if (pid !== null && pid > 1 && startedAt > booted) killGroup(pid);
          const tail = readOutputTail(task.outputPath, limits, null) ?? EMPTY_TAIL;
          record({
            taskId: task.id, parentThreadId: task.parentThreadId, status: "interrupted", stoppedBy: null, exitCode: null, error: null, outcome: "interrupted", signal: null,
            tell: true, tail, durationMs: Math.max(0, now().getTime() - startedAt)
          });
        } catch (err) {
          logError(`background command ${task.id}: its restart could not be recorded`, err);
        }
      }
    },

    dispose() {
      disposed = true;
      const at = Date.now();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // Every signal first: a database write below can wait out its busy
      // timeout, and the server exits right after.
      for (const slot of pending) {
        slot.cancelled = true;
        if (slot.child?.pid) killGroup(slot.child.pid);
      }
      for (const r of running.values()) {
        if (r.liveTimer) clearTimeout(r.liveTimer);
        if (r.process.pid) killGroup(r.process.pid);
      }
      for (const [pid, since] of dying) if (at - since < DYING_MS) killGroup(pid);
      dying.clear();
      for (const r of running.values()) {
        closeFd(r);
        // Killed now: the next start must not kill whatever takes its group id.
        try { deps.tasks.clearPid(r.id); } catch (err) { logError(`background command ${r.id}: its pid could not be cleared`, err); }
      }
      running.clear();
    }
  };
}

const EMPTY_TAIL: CommandTail = { text: "", shownLines: 0, totalLines: 0, bytes: 0 };

/** A command's end as it is written. */
interface End {
  taskId: string;
  parentThreadId: string;
  status: "finished" | "failed" | "stopped" | "interrupted";
  stoppedBy: BackgroundTaskStoppedBy | null;
  exitCode: number | null;
  error: string | null;
  outcome: CommandOutcome;
  signal: string | null;
  /** An archive meanwhile clears it. */
  tell: boolean;
  tail: CommandTail;
  durationMs: number;
}

function closeFd(r: Running): void {
  if (r.fd === null) return;
  try { fs.closeSync(r.fd); } catch { /* closed */ }
  r.fd = null;
}

/** The unfinished line when it is not blank, else the last non-blank
 *  finished line: a function of the bytes alone, however they were cut into
 *  chunks. At most LAST_LINE_CHARS characters, decoded from the bytes kept
 *  of it. */
function lastLineOf(r: Running, chunk: Buffer): string {
  const lastNewline = chunk.lastIndexOf(10);
  if (lastNewline === -1) {
    r.partial = keepLineStart(Buffer.concat([r.partial, chunk.subarray(0, LAST_LINE_BYTES)]));
    return shownUnfinished(r.partial) || r.lastFinished;
  }
  const finishing = r.partial;
  for (let end = lastNewline; ;) {
    // Blank lines are passed over byte by byte: read one at a time, a flood
    // of them (`yes ''`) kept the server busy ~77 s a GB. With none but blank
    // ones before it, the first line is next: the last chunk began it.
    let last = end - 1;
    while (last >= 0 && isBlankByte(chunk[last]!)) last--;
    end = chunk.indexOf(10, Math.max(last, 0));
    const start = end === 0 ? 0 : chunk.lastIndexOf(10, end - 1) + 1;
    const line = start === 0
      ? Buffer.concat([finishing, chunk.subarray(0, Math.min(end, LAST_LINE_BYTES))])
      : chunk.subarray(start, Math.min(end, start + LAST_LINE_BYTES));
    const found = shown(keepLineStart(line));
    if (found) {
      r.lastFinished = found;
      break;
    }
    if (start === 0) break;
    end = start - 1;
  }
  r.partial = keepLineStart(chunk.subarray(lastNewline + 1, lastNewline + 1 + LAST_LINE_BYTES));
  return shownUnfinished(r.partial) || r.lastFinished;
}

/** A space, a tab or a line break: a byte no shown line is made of alone. */
function isBlankByte(byte: number): boolean {
  return byte === 32 || (byte >= 9 && byte <= 13);
}

/** An unfinished line as shown: a character whose bytes have not all come
 *  yet is left out until they have. */
function shownUnfinished(bytes: Buffer): string {
  const text = [...new StringDecoder("utf8").write(bytes).trimEnd()].slice(0, LAST_LINE_CHARS).join("");
  return text.trim() ? text : "";
}

function keepLineStart(bytes: Buffer): Buffer {
  return bytes.length > LAST_LINE_BYTES ? Buffer.from(bytes.subarray(0, LAST_LINE_BYTES)) : Buffer.from(bytes);
}

/** A line as the last line shows it: its first LAST_LINE_CHARS characters;
 *  "" for a blank one. */
function shown(bytes: Buffer): string {
  const text = [...bytes.toString("utf8").trimEnd()].slice(0, LAST_LINE_CHARS).join("");
  return text.trim() ? text : "";
}
