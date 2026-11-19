import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { PageStore } from "./page-store.js";
import { pageFileDigest, PAGE_UPDATES_FILE } from "./page-publisher.js";
import { checkRepeat } from "../calendar/calendar-rules.js";
import { describeCron, nextDue } from "../schedules/cron.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { AGENT_PAGE_LIMITS, AGENT_PAGE_SOURCE_NAME, type AgentPageBuiltin, type AgentPageUpdateDto, type AgentPageUpdateOutcome } from "../../../shared/api/agent-page.js";
import { errorText } from "../../../shared/error-text.js";
import { logError } from "../../platform/logger.js";
import { stallWatch } from "../../platform/diagnostics/stall-watch.js";

/** How often due updates are looked for: a cron names minutes. */
const TICK_MS = 30_000;

interface Row {
  name: string;
  position: number;
  cron: string;
  task: string;
  paused: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_outcome: AgentPageUpdateOutcome | null;
  last_error: string | null;
  /** What had changed when it last started a run: the same at its next
   *  time, nothing has, and the time is skipped. */
  last_digest: string | null;
}

/** An update as updates.json lists it, checked. */
interface Listed { name: string; cron: string; task: string }

export interface PageUpdateManagerDeps {
  db: Database;
  /** Where updates.json is. */
  pageDir: string;
  /** A removal rewrites updates.json: its new digest is kept, so the
   *  publisher does not apply the file again. */
  store: Pick<PageStore, "setFileDigest" | "fileDigest">;
  sse: Pick<AgentSseEmitter, "emit">;
  /** The zone the crons are read in: this machine's, as it is now. */
  timeZone: () => string;
  /** Starts a page subagent for an update; its task id, or null when none
   *  can start (no personal agent yet). */
  startRun(title: string, task: string): string | null;
  /** Whether a page subagent an update started is still queued or running. */
  runOpen(taskId: string): boolean;
  /** What the page draws from and the personal agent's notes, as one digest. */
  changeDigest(): Promise<string>;
  now?: () => number;
}

const toUpdate = (row: Row): AgentPageUpdateDto => ({
  name: row.name,
  when: row.cron,
  whenText: describeCron(row.cron),
  task: row.task,
  paused: row.paused === 1,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  lastOutcome: row.last_outcome,
  lastError: row.last_error
});

/**
 * The page's scheduled updates: what updates.json lists. At each time an
 * update's cron names, a page subagent is started with its task, unless
 * nothing the page draws from, nor the personal agent's notes, has changed
 * since that update last started one. A time missed while Mandate was down
 * comes once; one that comes while the update's last run still goes is let
 * go. The table is the truth.
 */
export class PageUpdateManager {
  private readonly now: () => number;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private disposed = false;

  constructor(private readonly deps: PageUpdateManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Due updates are looked for from now on. */
  start(): void {
    if (this.ticker || this.disposed) return;
    this.ticker = setInterval(() => {
      void stallWatch.watched("page updates", () => this.runDue()).catch((err: unknown) => logError("page updates: a tick failed", err));
    }, TICK_MS);
    this.ticker.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Reads updates.json and makes the updates what it lists: new ones
   *  added, due at their next time; a changed one changed (a new `when`
   *  due at its next time); the rest removed. One paused stays paused, and
   *  how each last went stays. A file wrong in any way changes nothing and
   *  says why. No file: no updates. */
  applyFile(): { names: string[] | null; error: string | null } {
    const read = this.readFile();
    if ("error" in read) return { names: null, error: read.error };
    const listed = read.listed;
    const now = new Date(this.now());
    const before = new Map(this.rows().map((row) => [row.name, row]));
    this.deps.db.transaction(() => {
      for (const [name] of before) {
        if (!listed.some((update) => update.name === name)) this.deps.db.prepare("delete from agent_page_updates where name = ?").run(name);
      }
      listed.forEach((update, position) => {
        const old = before.get(update.name);
        if (!old) {
          this.deps.db.prepare("insert into agent_page_updates (name, position, cron, task, next_run_at) values (?, ?, ?, ?, ?)")
            .run(update.name, position, update.cron, update.task, this.nextAfter(update.cron, now));
        } else if (old.cron !== update.cron) {
          this.deps.db.prepare("update agent_page_updates set position = ?, cron = ?, task = ?, next_run_at = ? where name = ?")
            .run(position, update.cron, update.task, this.nextAfter(update.cron, now), update.name);
        } else {
          this.deps.db.prepare("update agent_page_updates set position = ?, task = ? where name = ?").run(position, update.task, update.name);
        }
      });
    }).immediate();
    this.emit();
    return { names: listed.map((update) => update.name), error: null };
  }

  list(): AgentPageUpdateDto[] {
    return this.rows().map(toUpdate);
  }

  /** The running updates as updates.json: applied, it changes nothing. */
  fileText(): string {
    const listed = this.rows().map((row) => ({ name: row.name, when: row.cron, task: row.task }));
    return `${JSON.stringify(listed, null, 2)}\n`;
  }

  /** Paused, it does not run; resumed, it is due at its next time. */
  setPaused(name: string, paused: boolean): AgentPageUpdateDto | null {
    const row = this.row(name);
    if (!row) return null;
    if (paused) this.deps.db.prepare("update agent_page_updates set paused = 1 where name = ?").run(name);
    else this.deps.db.prepare("update agent_page_updates set paused = 0, next_run_at = ? where name = ?").run(this.nextAfter(row.cron, new Date(this.now())), name);
    this.emit();
    return toUpdate(this.row(name)!);
  }

  /** Gone, and taken out of updates.json so the next apply does not bring
   *  it back. A file that does not parse is left as it is. When what is
   *  left is what runs, the rewrite counts as applied; a file with edits
   *  not applied (not yet, or refused) stays due, so they are applied at its
   *  writer's end. */
  remove(name: string): boolean {
    const removed = this.deps.db.prepare("delete from agent_page_updates where name = ?").run(name).changes > 0;
    if (!removed) return false;
    const file = path.join(this.deps.pageDir, PAGE_UPDATES_FILE);
    try {
      const before = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(before) as unknown;
      if (Array.isArray(parsed)) {
        const kept = parsed.filter((entry) => !(entry && typeof entry === "object" && (entry as { name?: unknown }).name === name));
        const content = `${JSON.stringify(kept, null, 2)}\n`;
        const applied = this.deps.store.fileDigest(PAGE_UPDATES_FILE) === pageFileDigest(before) && this.isRunning(kept);
        fs.writeFileSync(file, content);
        if (applied) this.deps.store.setFileDigest(PAGE_UPDATES_FILE, pageFileDigest(content));
      }
    } catch (err) {
      logError(`page updates: ${name} removed, but updates.json was left as it was`, err);
    }
    this.emit();
    return true;
  }

  /** Each due update: skipped when its last run still goes or nothing has
   *  changed since it started one, else its page subagent started; then due
   *  at its next time after now. */
  async runDue(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date(this.now());
      const due = this.deps.db.prepare(
        "select * from agent_page_updates where paused = 0 and next_run_at is not null and next_run_at <= ? order by next_run_at, position"
      ).all(now.toISOString()) as Row[];
      if (due.length === 0) return;
      let digest: string | null = null;
      for (const row of due) {
        const next = this.nextAfter(row.cron, now);
        if (this.stillRunning(row.name)) {
          this.deps.db.prepare("update agent_page_updates set next_run_at = ? where name = ?").run(next, row.name);
          continue;
        }
        digest ??= await this.deps.changeDigest();
        if (row.last_digest === digest) {
          this.deps.db.prepare(
            "update agent_page_updates set next_run_at = ?, last_run_at = ?, last_outcome = 'unchanged', last_error = null where name = ?"
          ).run(next, now.toISOString(), row.name);
          continue;
        }
        let taskId: string | null;
        try {
          taskId = this.deps.startRun(row.name, row.task);
        } catch (err) {
          this.deps.db.prepare(
            "update agent_page_updates set next_run_at = ?, last_run_at = ?, last_outcome = 'failed', last_error = ? where name = ?"
          ).run(next, now.toISOString(), errorText(err), row.name);
          continue;
        }
        if (taskId !== null) this.deps.db.prepare("insert or replace into agent_page_update_runs (task_id, name) values (?, ?)").run(taskId, row.name);
        this.deps.db.prepare("update agent_page_updates set next_run_at = ?, last_digest = ? where name = ?")
          .run(next, taskId === null ? row.last_digest : digest, row.name);
      }
      this.emit();
    } finally {
      this.ticking = false;
    }
  }

  /** A page subagent ended: when an update started it, how it went is
   *  kept on the update, if it is still listed (a failed one runs at the
   *  next time whatever changed); whether it was an update's. */
  runEnded(taskId: string, outcome: AgentPageUpdateOutcome, error: string | null): boolean {
    const run = this.deps.db.prepare("delete from agent_page_update_runs where task_id = ? returning name").get(taskId) as { name: string } | null;
    if (!run) return false;
    const changes = this.deps.db.prepare(
      `update agent_page_updates set last_run_at = ?, last_outcome = ?, last_error = ?,
         last_digest = case when ? = 'failed' then null else last_digest end
       where name = ?`
    ).run(new Date(this.now()).toISOString(), outcome, error, outcome, run.name).changes;
    if (changes > 0) this.emit();
    return true;
  }

  /** Whether a run this update started is still queued or running. One
   *  whose end was never heard of is let go here. */
  private stillRunning(name: string): boolean {
    const runs = this.deps.db.prepare("select task_id from agent_page_update_runs where name = ?").all(name) as Array<{ task_id: string }>;
    let open = false;
    for (const { task_id: taskId } of runs) {
      if (this.deps.runOpen(taskId)) open = true;
      else this.deps.db.prepare("delete from agent_page_update_runs where task_id = ?").run(taskId);
    }
    return open;
  }

  /** Whether these entries of updates.json are the updates running, as listed. */
  private isRunning(entries: unknown[]): boolean {
    const running = this.rows().map((row) => ({ name: row.name, cron: row.cron, task: row.task }));
    const listed = entries.map((entry) => {
      const { name, when, task } = (entry ?? {}) as Record<string, unknown>;
      return { name, cron: typeof when === "string" ? when.trim() : when, task };
    });
    return JSON.stringify(listed) === JSON.stringify(running);
  }

  /** The cron's next time after `after`; null when it is never due again. */
  private nextAfter(cron: string, after: Date): string | null {
    try {
      return nextDue(cron, this.deps.timeZone(), after).toISOString();
    } catch {
      return null;
    }
  }

  /** updates.json, checked whole: the updates it lists, or why not. */
  private readFile(): { listed: Listed[] } | { error: string } {
    const file = path.join(this.deps.pageDir, PAGE_UPDATES_FILE);
    let text: string;
    try {
      if (!fs.existsSync(file)) return { listed: [] };
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      return { error: `updates.json could not be read: ${errorText(err)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { error: `updates.json does not parse: ${errorText(err)}` };
    }
    if (!Array.isArray(parsed)) return { error: "updates.json must be a list of updates" };
    if (parsed.length > AGENT_PAGE_LIMITS.updates) return { error: `at most ${AGENT_PAGE_LIMITS.updates} updates, not ${parsed.length}` };
    const listed: Listed[] = [];
    for (const [index, entry] of parsed.entries()) {
      const checked = this.checkEntry(entry, index + 1);
      if ("error" in checked) return checked;
      if (listed.some((update) => update.name === checked.name)) return { error: `a duplicate name, ${checked.name}` };
      listed.push(checked);
    }
    return { listed };
  }

  private checkEntry(entry: unknown, n: number): Listed | { error: string } {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: `update ${n}: must be an object with name, when and task` };
    const { name, when, task } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !AGENT_PAGE_SOURCE_NAME.test(name)) {
      return { error: `update ${n}: name ${JSON.stringify(name ?? null)} may use only letters, digits, - and _ (at most 40)` };
    }
    if (typeof when !== "string" || !when.trim()) return { error: `update ${n}: when must be a 5-field cron expression` };
    const now = this.now();
    try {
      nextDue(when, this.deps.timeZone(), new Date(now));
    } catch {
      return { error: `update ${n}: when ${JSON.stringify(when)} is not a 5-field cron expression` };
    }
    try {
      checkRepeat(when, this.deps.timeZone(), now);
    } catch {
      return { error: `update ${n}: may be due at most once an hour` };
    }
    if (typeof task !== "string" || !task.trim()) return { error: `update ${n}: task must be text` };
    if (Array.from(task).length > AGENT_PAGE_LIMITS.updateTaskMaxChars) return { error: `update ${n}: task is over ${AGENT_PAGE_LIMITS.updateTaskMaxChars} characters` };
    return { name, cron: when.trim(), task };
  }

  private rows(): Row[] {
    return this.deps.db.prepare("select * from agent_page_updates order by position, rowid").all() as Row[];
  }

  private row(name: string): Row | null {
    return (this.deps.db.prepare("select * from agent_page_updates where name = ?").get(name) as Row | undefined) ?? null;
  }

  private emit(): void {
    this.deps.sse.emit(SSE_EVENTS.agentPageUpdatesChanged, { updates: this.list() });
  }
}

/** Every file under the notes, by path, size and time: what the notes are. */
function notesSeen(dir: string, root = dir, seen: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return seen;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) notesSeen(file, root, seen);
    else if (entry.isFile()) {
      try {
        const stat = fs.statSync(file);
        seen.push(`${path.relative(root, file)}\0${stat.size}\0${stat.mtimeMs}`);
      } catch {
        // Gone between the listing and the look.
      }
    }
  }
  return seen;
}

/** The built-ins a scheduled update compares: what moved in the work and
 *  waits on the user. Usage moves with every call, and a worker's line with
 *  every step, so they are left out; a thread's state carries its workers'. */
export const PAGE_CHANGE_BUILTINS = ["threads", "waiting", "canvases", "questions", "answers", "on_duty", "tasks"] as const satisfies readonly AgentPageBuiltin[];

/** What the page draws from (`data`, as one value) and the personal agent's
 *  notes, as one digest: the same while nothing of either changed. */
export async function pageChangeDigest(input: { data: () => Promise<unknown>; notesDir: string }): Promise<string> {
  const data = JSON.stringify(await input.data());
  const notes = notesSeen(input.notesDir).sort().join("\n");
  return createHash("sha256").update(data).update("\n\0\n").update(notes).digest("hex");
}
