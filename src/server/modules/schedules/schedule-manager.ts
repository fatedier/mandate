import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { stallWatch } from "../../platform/diagnostics/stall-watch.js";
import { scheduleScratchDir, schedulesScratchRoot, segment } from "../../platform/fs/resources.js";
import { logError } from "../../platform/logger.js";
import type { ShellCommandRunner } from "../../platform/process/shell-command-runner.js";
import { formatAgentTime, localTimeZone } from "../../platform/time/agent-time.js";
import type { DutyLevel, ScheduleActionError, ScheduleActionResponse, ScheduleDto, ScheduleRunDto, ScheduleRunOutcome } from "../../../shared/api/schedules.js";
import { deliverWakeMessage, type WakeDeliveryDeps } from "../agent/wake-delivery.js";
import { cutKeepingWhole } from "../agent/tool-output-spool.js";
import { decideCheck, parseCheckOutput, SCHEDULE_LIMITS, type CheckItem, type CheckParse, type SeenItems } from "./check-contract.js";
import { nextDue, ScheduleRefusal } from "./cron.js";
import { joinPendingWakes, renderScheduleWake, scheduleNotes } from "./schedule-messages.js";
import { scheduleDto } from "./schedule-dto.js";
import type { ScheduleRow, ScheduleStore } from "./schedule-store.js";
import { DEFAULT_RUNTIME_CONFIG } from "../../config/runtime-config.js";

export interface ScheduleRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ScheduleRunner {
  run(command: string, options: { cwd: string; timeoutMs: number; env: Record<string, string> }): Promise<ScheduleRunResult>;
}

/** The shell runner for checks: output capped, keeping the tail, so a long
 *  output still ends with the check's answer line. */
export function scheduleRunnerFrom(runner: ShellCommandRunner): ScheduleRunner {
  return {
    run: (command, options) => runner.run(command, {
      cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env,
      maxOutputBytes: SCHEDULE_LIMITS.captureMaxBytes, keepTail: true
    })
  };
}

export interface ScheduleClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const DEFAULT_SCHEDULE_CLOCK: ScheduleClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export type DutyTarget = { newTitle: string } | { threadId: string };

export interface CreateScheduleInput {
  name: string;
  cron: string;
  timezone?: string;
  check: string;
  brief: string;
  level?: DutyLevel;
  thread: DutyTarget;
  checkTimeoutMs?: number;
  /** Saved paused, for this reason: nothing runs until it is resumed. */
  pausedReason?: string;
}

export interface UpdateScheduleInput {
  name?: string;
  cron?: string;
  timezone?: string;
  check?: string;
  brief?: string;
  level?: DutyLevel;
  checkTimeoutMs?: number;
  resetState?: boolean;
}

export type CreateResult = { status: "created"; schedule: ScheduleDto } | { error: string };

export type UpdateResult = { status: "updated"; schedule: ScheduleDto } | { error: string };

/** `changed`: its check was cut off by a change to the schedule while it ran. */
export type RunNowResult = { outcome: ScheduleRunOutcome; line: string } | { status: "running" } | { error: string; changed?: true };

export interface ScheduleManagerDeps extends WakeDeliveryDeps {
  store: ScheduleStore;
  runner: ScheduleRunner;
  /** The startup switch: when on, no check runs. */
  disabled: boolean;
  clock?: ScheduleClock;
  /** How often the schedules are looked at, and how far apart what came due
   *  while the server was down runs after a start (config.json's runtime). */
  pace?: { tickMs: number; bootStaggerMs: number };
  dataDir?: string;
  timeZone?: () => string;
  /** A note to the personal agent: first runs, failing checks, pauses. */
  tellAgent: (text: string) => void;
  /** A note the personal agent reads at its next turn, without waking it: what the
   *  owner did on the On duty page. */
  noteAgent?: (text: string) => void;
  /** Opens a new duty thread or takes an existing one, and sends it the brief. */
  openDutyThread: (target: DutyTarget, brief: string, level: DutyLevel) => { threadId: string } | { error: string };
  onScheduleChanged?: (threadId: string) => void;
  retryRefused?: (threadId: string, who: string, err: unknown) => void;
}

/** Kept for the schedule's check: `new`, a check update gave that has not run
 *  yet (its first failure is told at once); or what an older version kept for
 *  a check it was still testing when it stopped (a new schedule's, it had no
 *  thread yet, or a new check's), taken over at the start. */
type PendingCheck =
  | { kind: "new" }
  | { kind: "create"; target: DutyTarget; level: DutyLevel | null }
  | { kind: "update"; check: string; timeoutMs: number; resetState: boolean };

const NEW_CHECK = JSON.stringify({ kind: "new" } satisfies PendingCheck);

type StorePatch = Parameters<ScheduleStore["update"]>[1];
type ScheduleRunRecord = Omit<Parameters<ScheduleStore["recordRun"]>[0], "outcome" | "line">;

/** A check run as it came due, asked for now, or as the first run of a
 *  new schedule or a new check. */
type RunKind = "due" | "manual" | "first";

/** A wake kept for a busy thread, rendered when it is delivered. */
interface PendingEntry {
  key: string;
  dueAt: string;
  ranAt: string;
  missed: number;
  message: string | null;
  items: CheckItem[];
  context: string;
}

/** Wakes kept per schedule while its thread is busy; past this the oldest
 *  folds into the next (its items kept, its message and output dropped). */
const PENDING_MAX = 20;
/** Due times counted when collapsing a downtime. */
const MISSED_COUNT_MAX = 100_000;

const DISABLED = "Schedules are off: config.json sets schedules.enabled to false.";
/** Why a schedule the owner paused on the On duty page is paused. */
const OWNER_PAUSED = "Paused by the user on the On duty page";
/** How long the owner's Run now waits for its check before answering running. */
const OWNER_RUN_WAIT_MS = 5_000;
/** The status an older version gave a new schedule until its test passed. */
const OLD_TESTING = "testing";
const NAME_MAX_CHARS = 80;
const ERROR_LINE_MAX_CHARS = 300;

/** Schedules: at each cron time a model-free check runs, and only when it
 *  says so is the schedule's duty thread woken. A new schedule first runs once
 *  at once in the background: what it finds is the starting point (so does
 *  the next run after a reset of its state). The tables are the source of
 *  truth; in memory are only the checks running now and the overdue due
 *  times found at the start. */
export class ScheduleManager {
  private readonly clock: ScheduleClock;
  private readonly pace: { tickMs: number; bootStaggerMs: number };
  private readonly running = new Set<string>();
  private active = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private readonly background = new Set<Promise<unknown>>();
  /** Overdue at the start: not run before this time, so a backlog starts
   *  5 s apart. The due time itself stays in the row. */
  private readonly notBefore = new Map<string, number>();
  private readonly delivering = new Map<string, Promise<string | null>>();
  /** Bumped by whatever makes a check in flight stale (pause, resume, a new
   *  check, delete): its result is then dropped. */
  private readonly epochs = new Map<string, number>();
  /** Resumes that asked for a first run while a check of the schedule ran:
   *  it starts when that check ends. */
  private readonly firstRunAsked = new Set<string>();
  private readonly ticker: unknown;
  private disposed = false;

  constructor(private readonly deps: ScheduleManagerDeps) {
    this.clock = deps.clock ?? DEFAULT_SCHEDULE_CLOCK;
    this.pace = deps.pace ?? { tickMs: DEFAULT_RUNTIME_CONFIG.scheduleTickMs, bootStaggerMs: DEFAULT_RUNTIME_CONFIG.scheduleBootStaggerMs };
    this.takeOverOldTests();
    this.sweepScratch();
    this.restoreInterruptedRuns();
    this.staggerOverdue();
    for (const row of this.deps.store.all()) {
      if (row.pendingWakeJson || row.pendingMessageId) void this.deliverOutsideRelease(row.id, row.threadId);
      // A new schedule's first run a stop cut off runs again, once the
      // runtime is up.
      if (row.firstRunPendingSince) this.track(Promise.resolve().then(() => this.startFirstRun(row.id)));
    }
    this.ticker = this.clock.setInterval(() => {
      void stallWatch.watched("schedules", () => this.runDue()).catch((err: unknown) => logError("schedules: a tick failed", err));
    }, this.pace.tickMs);
  }

  async create(input: CreateScheduleInput): Promise<CreateResult> {
    if (this.deps.disabled) return { error: DISABLED };
    let checked: { timezone: string; timeoutMs: number };
    try {
      checked = this.validate(input);
      if ("threadId" in input.thread && !this.deps.store.isDutyThread(input.thread.threadId)) {
        throw new ScheduleRefusal(`not a duty thread: ${input.thread.threadId}; give newTitle to open one`);
      }
    } catch (err) {
      return { error: errorText(err) };
    }
    const opened = this.openThread(input.thread, input.brief, input.level ?? null);
    if ("error" in opened) return { error: opened.error };
    const at = this.nowIso();
    const cron = input.cron.trim();
    const paused = input.pausedReason !== undefined;
    const row = this.deps.store.insert({
      threadId: opened.threadId, name: input.name.trim(), cron, timezone: checked.timezone, checkScript: input.check,
      checkTimeoutMs: checked.timeoutMs, brief: input.brief, status: paused ? "paused" : "active", pausedReason: input.pausedReason ?? null,
      nextDueAt: paused ? null : this.nextAfter({ cron, timezone: checked.timezone }, this.clock.now()), firstRunPendingSince: at
    }, at);
    this.changed(row.threadId);
    this.startFirstRun(row.id);
    return { status: "created", schedule: this.dto(this.deps.store.get(row.id)!) };
  }

  async update(id: string, patch: UpdateScheduleInput): Promise<UpdateResult> {
    const row = this.deps.store.get(id);
    if (!row) return { error: `no such schedule: ${id}` };
    const newCheck = patch.check !== undefined;
    const reset = patch.resetState === true;
    if ((newCheck || reset) && this.deps.disabled) return { error: DISABLED };
    let checked: { timezone: string; timeoutMs: number };
    try {
      checked = this.validate({
        name: patch.name ?? row.name, cron: patch.cron ?? row.cron, timezone: patch.timezone ?? row.timezone,
        check: patch.check ?? row.checkScript, brief: patch.brief ?? row.brief,
        checkTimeoutMs: patch.checkTimeoutMs ?? row.checkTimeoutMs
      });
    } catch (err) {
      return { error: errorText(err) };
    }
    const at = this.nowIso();
    const cron = patch.cron?.trim() ?? row.cron;
    const changesTime = patch.cron !== undefined || patch.timezone !== undefined;
    const fields: StorePatch = {
      name: patch.name?.trim() ?? row.name,
      cron,
      timezone: checked.timezone,
      brief: patch.brief ?? row.brief,
      checkTimeoutMs: checked.timeoutMs,
      ...(changesTime && row.status === "active" ? { nextDueAt: nextDue(cron, checked.timezone, new Date(this.clock.now())).toISOString() } : {}),
      // A new check takes over at once and runs nothing on its own: its next
      // run, due or asked for, is an ordinary check. A reset makes that run a
      // first run, whose findings are the starting point.
      ...(newCheck ? { checkScript: patch.check, consecutiveFailures: 0, pendingCheckJson: reset ? null : NEW_CHECK } : {}),
      ...(reset ? { checkStateJson: "{}", seenItemsJson: "[]", consecutiveFailures: 0, firstRunPendingSince: at } : {})
    };
    if (changesTime || newCheck || reset) this.invalidate(id, fields, at);
    else this.deps.store.update(id, fields, { at });
    if (patch.level) this.deps.store.setLevel(row.threadId, patch.level);
    this.changed(row.threadId);
    return { status: "updated", schedule: this.dto(this.deps.store.get(id)!) };
  }

  pause(target: { id: string } | { all: true }, reason: string): ScheduleDto[] {
    const at = this.nowIso();
    const rows = "id" in target ? [this.deps.store.get(target.id)].filter((r): r is ScheduleRow => r !== null) : this.deps.store.all();
    const paused: ScheduleDto[] = [];
    for (const row of rows) {
      if (row.status === "active") {
        this.invalidate(row.id, { status: "paused", pausedReason: reason }, at);
        this.changed(row.threadId);
      }
      const now = this.deps.store.get(row.id)!;
      if (now.status === "paused") paused.push(this.dto(now));
    }
    return paused;
  }

  resume(target: { id: string } | { all: true }): ScheduleDto[] | { error: string } {
    const at = this.nowIso();
    const rows = "id" in target ? [this.deps.store.get(target.id)].filter((r): r is ScheduleRow => r !== null) : this.deps.store.all();
    // A thread is never unarchived: its schedules would only pause again.
    if ("id" in target && rows[0] && this.threadGone(rows[0].threadId)) return { error: "its duty thread is archived" };
    const resumed: ScheduleDto[] = [];
    for (const row of rows) {
      if (this.threadGone(row.threadId)) continue;
      if (row.status !== "paused") continue;
      this.invalidate(row.id, {
        status: "active", pausedReason: null, consecutiveFailures: 0,
        nextDueAt: this.nextAfter(row, this.clock.now())
      }, at);
      this.changed(row.threadId);
      // A check that has not had its first run gets it now.
      this.startFirstRun(row.id, true);
      resumed.push(this.dto(this.deps.store.get(row.id)!));
    }
    return resumed;
  }

  async runNow(id: string): Promise<RunNowResult> {
    if (this.deps.disabled) return { error: DISABLED };
    const row = this.deps.store.get(id);
    if (!row) return { error: `no such schedule: ${id}` };
    if (row.status === "paused") return { error: `"${row.name}" is paused; resume it first` };
    if (this.running.has(id)) return { error: `a check of "${row.name}" is running now` };
    this.running.add(id);
    this.changed(row.threadId);
    const epoch = this.epochOf(id);
    const done = this.acquireSlot().then(() => {
      // Read afresh: the schedule may have changed while this waited for a slot.
      const current = this.deps.store.get(id);
      if (this.disposed || !current || current.status !== "active" || this.epochOf(id) !== epoch) return null;
      return this.runScheduled(current, "manual");
    }).finally(() => this.ended(id, row.threadId));
    const first = await this.foreground(done);
    if (first === "slow") {
      this.track(done);
      return { status: "running" };
    }
    return first ?? { error: `"${row.name}" changed while its check ran; nothing was done`, changed: true };
  }

  /** The owner pauses a schedule on the On duty page; the personal agent is told. */
  ownerPause(id: string): { schedule: ScheduleDto } | ScheduleActionError {
    const row = this.deps.store.get(id);
    if (!row) return { error: `no such schedule: ${id}`, code: "missing" };
    const was = row.status === "paused";
    this.pause({ id }, OWNER_PAUSED);
    if (!was) this.deps.noteAgent?.(scheduleNotes.ownerPaused(row.name));
    return { schedule: this.dto(this.deps.store.get(id)!) };
  }

  /** The owner resumes a schedule on the On duty page; the personal agent is told. */
  ownerResume(id: string): { schedule: ScheduleDto } | ScheduleActionError {
    const row = this.deps.store.get(id);
    if (!row) return { error: `no such schedule: ${id}`, code: "missing" };
    const resumed = this.resume({ id });
    if ("error" in resumed) return { error: resumed.error, code: "archived" };
    if (resumed.length > 0) this.deps.noteAgent?.(scheduleNotes.ownerResumed(row.name));
    return { schedule: this.dto(this.deps.store.get(id)!) };
  }

  /** The owner runs a schedule's check now; the personal agent is told once it ran
   *  or runs. What the check finds goes as any check's does. */
  async ownerRunNow(id: string): Promise<ScheduleActionResponse | ScheduleActionError> {
    const refused = this.runRefusal(id);
    if (refused) return refused;
    const name = this.deps.store.get(id)!.name;
    // The page hears the result over the stream: the request answers within
    // a few seconds, inside the server's 10 s for a quiet request.
    let timer: unknown = null;
    const slow = new Promise<"slow">((resolve) => { timer = this.clock.setTimeout(() => resolve("slow"), OWNER_RUN_WAIT_MS); });
    const result = await Promise.race([this.runNow(id), slow]);
    this.clock.clearTimeout(timer);
    if (result === "slow") {
      this.deps.noteAgent?.(scheduleNotes.ownerRan(name));
      return { status: "running" };
    }
    // Refused in the moment between the look above and the run.
    // Cut off by a change: said as that, whatever the schedule is now.
    if ("error" in result) return result.changed ? { error: result.error, code: "changed" } : this.runRefusal(id) ?? { error: result.error, code: "running" };
    this.deps.noteAgent?.(scheduleNotes.ownerRan(name));
    if ("status" in result) return { status: "running" };
    const row = this.deps.store.get(id);
    return row ? { schedule: this.dto(row) } : { error: `no such schedule: ${id}`, code: "missing" };
  }

  private runRefusal(id: string): ScheduleActionError | null {
    if (this.deps.disabled) return { error: DISABLED, code: "off" };
    const row = this.deps.store.get(id);
    if (!row) return { error: `no such schedule: ${id}`, code: "missing" };
    if (row.status === "paused") return { error: `"${row.name}" is paused`, code: "paused" };
    if (this.running.has(id)) return { error: `a check of "${row.name}" is running now`, code: "running" };
    return null;
  }

  /** On duty now: it has a schedule (its duty row outlives its last one). */
  private onDuty(threadId: string): boolean {
    return this.deps.store.isDutyThread(threadId) && this.deps.store.dutyThread(threadId) !== null;
  }

  /** A duty thread put in the owner's sidebar; false for a thread not on duty. */
  addToSidebar(threadId: string): boolean {
    if (!this.onDuty(threadId)) return false;
    this.deps.store.addToSidebar(threadId, this.nowIso());
    this.changed(threadId);
    return true;
  }

  removeFromSidebar(threadId: string): boolean {
    if (!this.onDuty(threadId)) return false;
    this.deps.store.removeFromSidebar(threadId);
    this.changed(threadId);
    return true;
  }

  delete(id: string): boolean {
    const row = this.deps.store.get(id);
    if (!row) return false;
    this.remove(id);
    this.notBefore.delete(id);
    this.bump(id);
    this.changed(row.threadId);
    return true;
  }

  /** An archived thread's schedules stop: the active ones are paused. */
  pauseThread(threadId: string, reason: string): ScheduleDto[] {
    const at = this.nowIso();
    const paused: ScheduleDto[] = [];
    for (const row of this.deps.store.byThread(threadId)) {
      if (row.status !== "active") continue;
      this.invalidate(row.id, { status: "paused", pausedReason: reason }, at);
      paused.push(this.dto(this.deps.store.get(row.id)!));
    }
    if (paused.length > 0) this.changed(threadId);
    return paused;
  }

  /** A duty thread archived: its schedules pause, and the personal agent is told
   *  once, every schedule named, those already paused too. */
  archiveThread(threadId: string): void {
    const rows = this.deps.store.byThread(threadId);
    if (rows.length === 0) return;
    this.pauseThread(threadId, "thread archived");
    const title = this.deps.agentStore.getThreadById(threadId)?.title ?? "";
    this.deps.tellAgent(scheduleNotes.archived(title, threadId, rows.map((row) => row.name)));
  }

  /** A duty thread about to be deleted, its schedules with it: what tells
   *  the personal agent once they are gone; null for a thread with none. */
  threadDeleting(threadId: string): (() => void) | null {
    const rows = this.deps.store.byThread(threadId);
    if (rows.length === 0) return null;
    const title = this.deps.agentStore.getThreadById(threadId)?.title ?? "";
    const names = rows.map((row) => row.name);
    return () => {
      for (const row of rows) this.removeScratch(row.id);
      this.deps.tellAgent(scheduleNotes.deleted(title, threadId, names));
    };
  }

  /** A schedule gone, and its folder with it: the check and state written
   *  there are copies of its row's, and what the check left is scratch. */
  private remove(id: string): void {
    this.deps.store.delete(id);
    this.removeScratch(id);
  }

  private removeScratch(id: string): void {
    removeFolder(scheduleScratchDir(id, this.deps.dataDir));
  }

  /** At the start: the folders whose schedule is gone (one that could not be
   *  removed, or left before schedules took theirs with them). */
  private sweepScratch(): void {
    const root = schedulesScratchRoot(this.deps.dataDir);
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    const live = new Set(this.deps.store.all().map((row) => segment(row.id)));
    for (const name of names) if (!live.has(name)) removeFolder(path.join(root, name));
  }

  list(): ScheduleDto[] {
    return this.deps.store.all().map((row) => this.dto(row));
  }

  runs(scheduleId: string, limit = 10): ScheduleRunDto[] {
    return this.deps.store.runs(scheduleId, limit).map((run) => ({
      startedAt: run.startedAt, outcome: run.outcome, line: run.line, missed: run.missed, durationMs: run.durationMs
    }));
  }

  /** The tick: start due checks up to the limit; one still running is skipped. */
  async runDue(): Promise<void> {
    if (this.disposed || this.deps.disabled) return;
    const started: Array<Promise<unknown>> = [];
    for (const row of this.deps.store.due(this.nowIso())) {
      if (this.running.has(row.id)) {
        this.skip(row, "skipped_overlap");
        continue;
      }
      if ((this.notBefore.get(row.id) ?? 0) > this.clock.now()) continue;
      if (this.threadGone(row.threadId)) {
        this.archiveThread(row.threadId);
        continue;
      }
      // No slot: it stays due for the next tick; the rest are still looked
      // at, so checks holding the slots have their overlaps recorded.
      if (!this.tryAcquireSlot()) continue;
      this.notBefore.delete(row.id);
      this.running.add(row.id);
      // Its row says a check runs, in every tab, until the result.
      this.changed(row.threadId);
      started.push(this.runScheduled(row, "due").finally(() => this.ended(row.id, row.threadId)));
    }
    await Promise.all(started);
  }

  /** Delivers the thread's schedule wakes kept while it was busy. */
  async flushPendingWake(threadId: string): Promise<string | null> {
    for (const row of this.deps.store.byThread(threadId)) {
      if (!row.pendingWakeJson && !row.pendingMessageId) continue;
      const wakeId = await this.deliver(row.id);
      if (wakeId) return wakeId;
      const after = this.deps.store.get(row.id);
      if (after && (after.pendingWakeJson || after.pendingMessageId)) return null;
    }
    return null;
  }

  /** First runs and slow manual runs, settled. */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Clears timers only; rows stay and are picked up on the next start. */
  dispose(): void {
    this.disposed = true;
    this.clock.clearInterval(this.ticker);
  }

  dto(row: ScheduleRow): ScheduleDto {
    return scheduleDto(row, this.running.has(row.id));
  }

  /** A check of the schedule is in flight now, scheduled or asked for. */
  isRunning(scheduleId: string): boolean {
    return this.running.has(scheduleId);
  }

  /** One check of a schedule, as it came due, asked for now, or as its
   *  first run; its slot is held. Null when the schedule changed while it
   *  ran (deleted, paused, a new check): the result is then dropped. */
  private async runScheduled(row: ScheduleRow, kind: RunKind): Promise<{ outcome: ScheduleRunOutcome; line: string } | null> {
    const due = kind === "due";
    // A first run, at once or as the next run after a reset; or the first run
    // of a check update gave.
    const first = kind === "first" || row.firstRunPendingSince !== null;
    const untried = !first && parsePending(row.pendingCheckJson)?.kind === "new";
    const startMs = this.clock.now();
    const startIso = new Date(startMs).toISOString();
    const dueAt = due ? row.nextDueAt ?? startIso : startIso;
    const missed = due ? Math.max(0, dueTimesThrough(row, startMs) - 1) : 0;
    // The floor guards repeats: a first run is none, and a check a tick
    // started a few seconds late is none either.
    if (due && row.lastRunAt && row.lastOutcome !== "test" && startMs - Date.parse(row.lastRunAt) < SCHEDULE_LIMITS.floorMs - this.pace.tickMs) {
      this.skip(row, "skipped_floor");
      return { outcome: "skipped_floor", line: "" };
    }
    // The due time in flight is kept until its result is in: a restart that
    // cuts the check off runs it again.
    if (due) this.deps.store.update(row.id, { nextDueAt: this.nextAfter(row, startMs), runningDueAt: dueAt }, { at: startIso });
    const epoch = this.epochOf(row.id);
    const result = await this.execute(row, dueAt);
    if (this.disposed) return null;
    const current = this.deps.store.get(row.id);
    if (!current) return null;
    if (current.status !== "active" || current.checkScript !== row.checkScript || this.epochOf(row.id) !== epoch) {
      if (due) this.deps.store.update(row.id, { runningDueAt: null }, { at: this.nowIso() });
      return null;
    }
    const finishedIso = this.nowIso();
    const durationMs = this.clock.now() - startMs;
    const run = { scheduleId: row.id, threadId: row.threadId, dueAt, startedAt: startIso, finishedAt: finishedIso, exitCode: result.exitCode, durationMs, missed };
    const parse = parseCheckOutput(result);
    if (!parse.ok) {
      this.fail(current, parse.error, run, startIso, first ? "first" : untried ? "new" : null);
      return { outcome: "failed", line: parse.error };
    }
    if (first) return this.firstRan(current, parse, run, startIso);
    const ran = { lastRunAt: startIso, runningDueAt: null, ...(untried ? { pendingCheckJson: null } : {}) };
    const decided = decideCheck(parse, seenOf(current));
    const state = parse.state === undefined ? current.checkStateJson : JSON.stringify(parse.state);
    // The run's line, kept in its history and said to whoever ran it: its
    // message, cut as a wake's is.
    const line = parse.message ? cutKeepingWhole(parse.message, SCHEDULE_LIMITS.wakeBodyMaxChars, { threadId: row.threadId }) : "";
    if (decided.kind === "quiet") {
      const outcome: ScheduleRunOutcome = due ? "quiet" : "manual_quiet";
      this.deps.store.transaction(() => {
        this.deps.store.update(row.id, { ...ran, checkStateJson: state, consecutiveFailures: 0, lastOutcome: outcome }, { at: finishedIso });
        this.deps.store.recordRun({ ...run, outcome, line });
      });
      this.changed(row.threadId);
      return { outcome, line };
    }
    const outcome: ScheduleRunOutcome = due ? "woke" : "manual_woke";
    const entry: PendingEntry = {
      key: randomUUID(), dueAt, ranAt: startIso, missed, message: parse.message, items: decided.newItems, context: parse.context
    };
    this.deps.store.transaction(() => {
      const latest = this.deps.store.get(row.id) ?? current;
      this.deps.store.update(row.id, {
        ...ran, checkStateJson: state, seenItemsJson: JSON.stringify(decided.seen), consecutiveFailures: 0,
        lastOutcome: outcome, pendingWakeJson: JSON.stringify(withEntry(pendingEntries(latest), entry))
      }, { at: finishedIso });
      this.deps.store.recordRun({ ...run, outcome, line });
    });
    this.changed(row.threadId);
    await this.deliverOutsideRelease(row.id, row.threadId);
    return { outcome, line };
  }

  /** A first run that passed: what it found is the starting point, its items
   *  marked seen and nothing woken; the personal agent is told. */
  private firstRan(row: ScheduleRow, parse: Extract<CheckParse, { ok: true }>, run: ScheduleRunRecord, startIso: string): { outcome: ScheduleRunOutcome; line: string } {
    const seen = decideCheck({ ...parse, wake: true }, seenOf(row)).seen;
    const state = parse.state === undefined ? row.checkStateJson : JSON.stringify(parse.state);
    const line = firstRunLine(parse, run.durationMs, row.threadId);
    this.deps.store.transaction(() => {
      this.deps.store.update(row.id, {
        lastRunAt: startIso, runningDueAt: null, checkStateJson: state, seenItemsJson: JSON.stringify(seen), consecutiveFailures: 0,
        lastOutcome: "test", firstRunPendingSince: null, pendingCheckJson: null
      }, { at: run.finishedAt });
      this.deps.store.recordRun({ ...run, outcome: "test", line });
    });
    this.changed(row.threadId);
    const schedule = this.dto(this.deps.store.get(row.id)!);
    const thread = this.deps.agentStore.getThreadById(schedule.threadId);
    const next = schedule.nextDueAt ? formatAgentTime(schedule.nextDueAt, schedule.timezone) ?? schedule.nextDueAt : "not scheduled";
    this.deps.tellAgent(scheduleNotes.firstRan(schedule.name, thread?.title ?? "", schedule.threadId, next, line));
    return { outcome: "test", line };
  }

  /** A failed check: one more in a row. A first run's failure, or a new
   *  check's first, is told at once; any other at the first of a streak, the
   *  third, and the fifth, which pauses it. */
  private fail(row: ScheduleRow, error: string, run: ScheduleRunRecord, startIso: string, firstOf: "first" | "new" | null): void {
    const failures = row.consecutiveFailures + 1;
    const at = this.nowIso();
    const pausing = failures >= SCHEDULE_LIMITS.failPauseAt;
    this.deps.store.transaction(() => {
      this.deps.store.update(row.id, {
        lastRunAt: startIso, runningDueAt: null, consecutiveFailures: failures, lastOutcome: "failed",
        ...(firstOf ? { firstRunPendingSince: null, pendingCheckJson: null } : {}),
        ...(pausing ? { status: "paused" as const, pausedReason: "check failing" } : {})
      }, { at });
      this.deps.store.recordRun({ ...run, outcome: "failed", line: error.slice(0, ERROR_LINE_MAX_CHARS) });
    });
    this.changed(row.threadId);
    if (firstOf === "first" && !pausing) this.deps.tellAgent(scheduleNotes.firstRunFailed(row.name, error));
    else if (firstOf === "new" && !pausing) this.deps.tellAgent(scheduleNotes.newCheckFailed(row.name, error));
    else if (failures === 1) this.deps.tellAgent(scheduleNotes.failedOnce(row.name, error));
    else if (failures === SCHEDULE_LIMITS.failNotifyAt) this.deps.tellAgent(scheduleNotes.failing(row.name, error));
    else if (failures === SCHEDULE_LIMITS.failPauseAt) this.deps.tellAgent(scheduleNotes.pausedFailing(row.name, error));
  }

  private skip(row: ScheduleRow, outcome: "skipped_overlap" | "skipped_floor"): void {
    const nowMs = this.clock.now();
    const at = new Date(nowMs).toISOString();
    this.deps.store.transaction(() => {
      this.deps.store.recordRun({
        scheduleId: row.id, threadId: row.threadId, dueAt: row.nextDueAt ?? at, startedAt: at, finishedAt: at,
        outcome, exitCode: null, durationMs: 0, line: "", missed: 0
      });
      this.deps.store.update(row.id, { nextDueAt: this.nextAfter(row, nowMs) }, { at });
    });
    this.changed(row.threadId);
  }

  /** Starts a new schedule's first run in the background, unless it is
   *  paused or a check of it runs now (that check's end starts it). One after
   *  a reset waits for its due time or Run now; a resume (`afterReset`) runs
   *  it too. It holds the schedule as running, so a due time meanwhile is an
   *  overlap and Run now waits. */
  private startFirstRun(id: string, afterReset = false): void {
    if (this.disposed || this.deps.disabled) return;
    if (this.running.has(id)) {
      if (afterReset) this.firstRunAsked.add(id);
      return;
    }
    const row = this.deps.store.get(id);
    if (!row || row.status !== "active" || !row.firstRunPendingSince || !row.threadId) return;
    if (!afterReset && row.lastRunAt !== null) return;
    // An older version's new schedule: its brief goes first.
    if (parsePending(row.pendingCheckJson)?.kind === "create") return;
    this.running.add(id);
    this.changed(row.threadId);
    const epoch = this.epochOf(id);
    this.track(this.acquireSlot().then(() => {
      // Read afresh: the schedule may have changed while this waited for a slot.
      const current = this.deps.store.get(id);
      if (this.disposed || !current || current.status !== "active" || !current.firstRunPendingSince || this.epochOf(id) !== epoch) return null;
      return this.runScheduled(current, "first");
    }).finally(() => {
      // Changed while it ran (a newer check, a pause and resume): the run
      // dropped stands for none, and the next starts.
      this.ended(id, row.threadId, this.epochOf(id) !== epoch);
    }));
  }

  /** A check of the schedule ended: its slot is free, its row republished
   *  (its result went out while it still counted as running), and a first
   *  run asked for meanwhile (a new schedule's, or a resume's) starts. */
  private ended(id: string, threadId: string, firstRunNext = true): void {
    this.running.delete(id);
    this.releaseSlot();
    this.changed(threadId);
    const asked = this.firstRunAsked.delete(id);
    if (firstRunNext || asked) this.startFirstRun(id, asked);
  }

  /** Opens a new duty thread, or takes one, sending it the brief; a level
   *  given for a thread already on duty is set on it. */
  private openThread(target: DutyTarget, brief: string, level: DutyLevel | null): { threadId: string } | { error: string } {
    const opened = this.deps.openDutyThread(target, brief, level ?? "investigate");
    if (!("error" in opened) && level && "threadId" in target) this.deps.store.setLevel(opened.threadId, level);
    return opened;
  }

  /** Writes the script and the state it reads, then runs it in the
   *  schedule's own directory. A runner that throws is a failed run. */
  private async execute(row: ScheduleRow, dueAt: string): Promise<ScheduleRunResult> {
    try {
      const dir = scheduleScratchDir(row.id, this.deps.dataDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "check.sh"), row.checkScript);
      const statePath = path.join(dir, "state.json");
      fs.writeFileSync(statePath, row.checkStateJson);
      return await this.deps.runner.run("bash ./check.sh", {
        cwd: dir, timeoutMs: row.checkTimeoutMs,
        env: { MANDATE_CHECK_STATE: statePath, MANDATE_DUE_AT: dueAt, MANDATE_LAST_RUN_AT: row.lastRunAt ?? "", MANDATE_SCHEDULE_ID: row.id }
      });
    } catch (err) {
      return { stdout: "", stderr: errorText(err), exitCode: -1, timedOut: false };
    }
  }

  private async deliverOutsideRelease(id: string, threadId: string): Promise<void> {
    try {
      await this.deliver(id);
    } catch (err) {
      if (this.deps.retryRefused) this.deps.retryRefused(threadId, `schedule ${id}`, err);
      else logError(`schedule ${id}: its wake was not delivered`, err);
    }
  }

  /** One delivery per schedule at a time, each reading the row afresh. */
  private deliver(id: string): Promise<string | null> {
    const previous = this.delivering.get(id) ?? Promise.resolve(null);
    const attempt = previous.then(() => this.deliverNow(id), () => this.deliverNow(id));
    this.delivering.set(id, attempt);
    const cleanup = () => {
      if (this.delivering.get(id) === attempt) this.delivering.delete(id);
    };
    attempt.then(cleanup, cleanup);
    return attempt;
  }

  /** The outbox: texts not yet in the thread go in as one message; a
   *  message already in (its wake refused) is woken on first. */
  private async deliverNow(id: string): Promise<string | null> {
    // With schedules off nothing is delivered: what was kept stays kept.
    if (this.disposed || this.deps.disabled) return null;
    const row = this.deps.store.get(id);
    if (!row) return null;
    const entries = pendingEntries(row);
    const messageId = row.pendingMessageId;
    if (!messageId && entries.length === 0) return null;
    const delivered = new Set(entries.map((e) => e.key));
    const result = await deliverWakeMessage(this.deps, {
      threadId: row.threadId,
      reason: "schedule",
      source: "schedule",
      messageId,
      render: () => renderEntries(row, entries),
      stillWanted: () => !this.disposed && this.deps.store.get(id) !== null,
      settle: (settled) => {
        const at = this.nowIso();
        switch (settled.status) {
          case "woken":
            this.deps.store.update(id, messageId ? { pendingMessageId: null } : { pendingWakeJson: this.leftAfter(id, delivered) }, { at });
            return;
          case "gone":
          case "retired":
            this.deps.store.update(id, { pendingMessageId: null, pendingWakeJson: null }, { at });
            return;
          case "busy":
            if (!messageId && settled.messageId) this.deps.store.update(id, { pendingMessageId: settled.messageId, pendingWakeJson: this.leftAfter(id, delivered) }, { at });
            return;
          case "abandoned":
            return;
        }
      }
    });
    return result.status === "woken" ? result.wakeId : null;
  }

  /** The kept wakes not among those just delivered: a check that landed
   *  during the delivery stays for the next one. */
  private leftAfter(id: string, delivered: ReadonlySet<string>): string | null {
    const row = this.deps.store.get(id);
    const left = row ? pendingEntries(row).filter((e) => !delivered.has(e.key)) : [];
    return left.length > 0 ? JSON.stringify(left) : null;
  }

  /** At the start: a check the restart cut off is due again at its own time. */
  private restoreInterruptedRuns(): void {
    const at = this.nowIso();
    for (const row of this.deps.store.all()) {
      if (!row.runningDueAt) continue;
      this.deps.store.update(row.id, {
        runningDueAt: null,
        ...(row.status === "active" ? { nextDueAt: row.runningDueAt } : {})
      }, { at });
    }
  }

  /** A write that makes a check in flight stale: its result will be
   *  dropped, and a restart will not run its due time again. */
  private invalidate(id: string, patch: StorePatch, at: string): void {
    this.deps.store.update(id, { ...patch, runningDueAt: null }, { at });
    this.bump(id);
  }

  private bump(id: string): void {
    this.epochs.set(id, this.epochOf(id) + 1);
  }

  private epochOf(id: string): number {
    return this.epochs.get(id) ?? 0;
  }

  /** At the start: what an older version was still testing when it stopped
   *  goes on as this one does. A new check takes over; a new schedule (its
   *  brief not sent yet, and on a new thread no thread yet) has its duty
   *  thread opened or taken once the runtime is up, then its first run. */
  private takeOverOldTests(): void {
    const at = this.nowIso();
    for (const row of this.deps.store.all()) {
      const pending = parsePending(row.pendingCheckJson);
      if (pending?.kind === "create") {
        // Its target stays kept until the thread is open: a stop before
        // then opens it at the next start.
        if ((row.status as string) === OLD_TESTING) {
          this.deps.store.update(row.id, { status: row.pausedReason ? "paused" : "active", firstRunPendingSince: row.firstRunPendingSince ?? at }, { at });
        }
        this.track(Promise.resolve().then(() => this.openOldCreate(row.id, pending)));
      } else if ((row.status as string) === OLD_TESTING) {
        logError("schedules", new Error("no thread to open"), `"${row.name}" was left mid-test by an older version`);
        this.remove(row.id);
      } else if (pending?.kind === "update") {
        // Taken over as an update now is: it runs when it comes due.
        this.deps.store.update(row.id, {
          checkScript: pending.check, checkTimeoutMs: pending.timeoutMs, consecutiveFailures: 0,
          ...(pending.resetState ? { checkStateJson: "{}", seenItemsJson: "[]", firstRunPendingSince: at, pendingCheckJson: null } : { pendingCheckJson: NEW_CHECK })
        }, { at });
      }
    }
  }

  /** An older version's new schedule: its duty thread, then its first run. */
  private openOldCreate(id: string, pending: { target: DutyTarget; level: DutyLevel | null }): void {
    if (this.disposed) return;
    const row = this.deps.store.get(id);
    if (!row?.pendingCheckJson) return;
    const opened = this.openThread(pending.target, row.brief, pending.level);
    if ("error" in opened) {
      logError("schedules", new Error(opened.error), `could not open the duty thread of "${row.name}"`);
      this.remove(id);
      return;
    }
    const at = this.nowIso();
    this.deps.store.transaction(() => {
      this.deps.store.setThread(id, opened.threadId, at);
      this.deps.store.update(id, {
        pendingCheckJson: null, ...(row.status === "active" ? { nextDueAt: this.nextAfter(row, this.clock.now()) } : {})
      }, { at });
    });
    this.changed(opened.threadId);
    this.startFirstRun(id);
  }

  /** At the start: what came due while the server was down runs once per
   *  schedule, 5 s apart, standing for every due time it missed (counted
   *  when it runs, from the due time the row keeps). */
  private staggerOverdue(): void {
    const nowMs = this.clock.now();
    const first = nowMs + this.pace.tickMs;
    this.deps.store.due(new Date(nowMs).toISOString()).forEach((row, i) => {
      this.notBefore.set(row.id, first + i * this.pace.bootStaggerMs);
    });
  }

  private validate(input: { name: string; cron: string; timezone?: string; check: string; brief: string; checkTimeoutMs?: number }): { timezone: string; timeoutMs: number } {
    const name = input.name.trim();
    if (!name) throw new ScheduleRefusal("a schedule needs a name");
    if (name.length > NAME_MAX_CHARS) throw new ScheduleRefusal(`the name is over ${NAME_MAX_CHARS} characters`);
    const timezone = input.timezone?.trim() || (this.deps.timeZone ?? localTimeZone)();
    nextDue(input.cron, timezone, new Date(this.clock.now()));
    if (!input.check.trim()) throw new ScheduleRefusal("the check is empty");
    if (Buffer.byteLength(input.check) > SCHEDULE_LIMITS.scriptMaxBytes) throw new ScheduleRefusal("the check is over 16 KB");
    if (!input.brief.trim()) throw new ScheduleRefusal("the brief is empty");
    if (input.brief.length > SCHEDULE_LIMITS.briefMaxChars) throw new ScheduleRefusal(`the brief is over ${SCHEDULE_LIMITS.briefMaxChars} characters`);
    const timeoutMs = input.checkTimeoutMs ?? SCHEDULE_LIMITS.checkTimeoutDefaultMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > SCHEDULE_LIMITS.checkTimeoutMaxMs) {
      throw new ScheduleRefusal("the check timeout must be between 1 s and 10 min");
    }
    return { timezone, timeoutMs };
  }

  private nextAfter(row: Pick<ScheduleRow, "cron" | "timezone">, afterMs: number): string | null {
    try {
      return nextDue(row.cron, row.timezone, new Date(afterMs)).toISOString();
    } catch (err) {
      logError(`schedule "${row.cron}" has no next due time`, err);
      return null;
    }
  }

  /** Resolves with the result, or "slow" once the personal agent's turn has waited
   *  as long as its foreground commands may. */
  private foreground<T>(work: Promise<T>): Promise<T | "slow"> {
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => resolve("slow"), SCHEDULE_LIMITS.foregroundMs);
      work.then((value) => {
        this.clock.clearTimeout(timer);
        resolve(value);
      }, (err: unknown) => {
        this.clock.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((err: unknown) => logError("schedules: a background run failed", err));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  /** Archived (or gone): its schedules run nothing again. A schedule with
   *  no thread yet (an older version's, until the start opens it) is not gone. */
  private threadGone(threadId: string): boolean {
    if (!threadId) return false;
    const thread = this.deps.agentStore.getThreadById(threadId);
    return !thread || Boolean(thread.archivedAt) || Boolean(this.deps.isThreadRetired?.(threadId));
  }

  private changed(threadId: string): void {
    if (threadId) this.deps.onScheduleChanged?.(threadId);
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private tryAcquireSlot(): boolean {
    if (this.active >= SCHEDULE_LIMITS.concurrent) return false;
    this.active++;
    return true;
  }

  private acquireSlot(): Promise<void> {
    if (this.tryAcquireSlot()) return Promise.resolve();
    return new Promise((resolve) => this.slotWaiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) next();
    else this.active--;
  }
}

/** Due times from the row's next one through `nowMs`. */
function dueTimesThrough(row: ScheduleRow, nowMs: number): number {
  if (!row.nextDueAt) return 0;
  let count = 0;
  let at = new Date(Date.parse(row.nextDueAt) - 1);
  for (; count < MISSED_COUNT_MAX; count++) {
    let next: Date;
    try {
      next = nextDue(row.cron, row.timezone, at);
    } catch {
      break;
    }
    if (next.getTime() > nowMs) break;
    at = next;
  }
  return count;
}

function seenOf(row: ScheduleRow): SeenItems {
  try {
    const parsed = JSON.parse(row.seenItemsJson) as unknown;
    return Array.isArray(parsed) ? (parsed as SeenItems) : [];
  } catch {
    return [];
  }
}

function pendingEntries(row: ScheduleRow): PendingEntry[] {
  if (!row.pendingWakeJson) return [];
  try {
    const parsed = JSON.parse(row.pendingWakeJson) as unknown;
    return Array.isArray(parsed) ? (parsed as PendingEntry[]) : [];
  } catch {
    return [];
  }
}

/** The kept wakes with one more; past the limit the oldest folds into the
 *  next, so no item is lost. */
function withEntry(entries: readonly PendingEntry[], entry: PendingEntry): PendingEntry[] {
  const next = [...entries, entry];
  while (next.length > PENDING_MAX) {
    const [oldest, following] = next as [PendingEntry, PendingEntry];
    const ids = new Set(following.items.map((item) => item.id));
    next.splice(0, 2, { ...following, items: [...oldest.items.filter((item) => !ids.has(item.id)), ...following.items] });
  }
  return next;
}

/** Kept wakes as one message: the newest with its output, the others
 *  without (their items and messages are what is new in them). */
function renderEntries(row: ScheduleRow, entries: readonly PendingEntry[]): string {
  const fit = (body: string) => cutKeepingWhole(body, SCHEDULE_LIMITS.wakeBodyMaxChars, { threadId: row.threadId });
  return joinPendingWakes(entries.map((entry, i) => renderScheduleWake({
    name: row.name, id: row.id, timezone: row.timezone, dueAt: entry.dueAt, ranAt: entry.ranAt, missed: entry.missed,
    message: entry.message, items: entry.items, context: i === entries.length - 1 ? entry.context : "", fit
  })));
}

function parsePending(json: string | null): PendingCheck | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as PendingCheck;
  } catch {
    return null;
  }
}

/** A first run, in one line; its message cut as a wake's is, the whole
 *  saved beside the duty thread's. */
function firstRunLine(parse: Extract<CheckParse, { ok: true }>, durationMs: number, threadId: string): string {
  const items = parse.items?.length ?? 0;
  const seconds = (durationMs / 1000).toFixed(1);
  const message = parse.message ? cutKeepingWhole(parse.message, SCHEDULE_LIMITS.wakeBodyMaxChars, { threadId }) : null;
  return `ran in ${seconds} s; ${items} item${items === 1 ? "" : "s"} taken as the starting point${message ? `; message: ${message}` : ""}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function removeFolder(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logError("schedules", err, `could not remove ${dir}`);
  }
}
