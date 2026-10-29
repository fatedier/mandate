import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MONITOR_CAPTURE_MAX_BYTES, type MonitorClock, type MonitorRunResult, type MonitorRunner } from "../agent/command-monitor-manager.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { PageStore } from "./page-store.js";
import { pageFileDigest, PAGE_SOURCES_FILE } from "./page-publisher.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { AGENT_PAGE_BUILTINS, AGENT_PAGE_LIMITS, AGENT_PAGE_SOURCE_NAME, type AgentPageDataDto, type AgentPageSourceDto } from "../../../shared/api/agent-page.js";
import { formatDurationShort, parseDurationMs } from "../../../shared/duration-short.js";
import { errorText } from "../../../shared/error-text.js";
import { logError } from "../../platform/logger.js";

/** How often due sources are looked for. */
const TICK_MS = 5000;
/** How much of a failing run's output its error keeps. */
const ERROR_DETAIL_MAX_CHARS = 500;

interface Row {
  name: string;
  position: number;
  run: string;
  every_ms: number;
  cwd: string | null;
  paused: number;
  next_run_at: string;
  last_run_at: string | null;
  value_json: string | null;
  value_at: string | null;
  last_error: string | null;
  revision: number;
}

/** A source's generation: new at each insert and each change of its
 *  command, never reused, so a run started before is told apart even when a
 *  removed name comes back. */
const newGeneration = () => randomInt(1, 2 ** 47);

/** A source as sources.json lists it, checked. */
interface Listed { name: string; run: string; everyMs: number; cwd: string | null }

export interface PageSourceManagerDeps {
  db: Database;
  runner: MonitorRunner;
  /** Where sources.json is. */
  pageDir: string;
  /** Where a command runs, and what a relative cwd is read from: Your
   *  agent's working directory, where its own shell starts. */
  defaultCwd: string;
  /** A removal rewrites sources.json: its new digest is kept, so the
   *  publisher does not apply the file again. */
  store: Pick<PageStore, "setFileDigest" | "fileDigest">;
  sse: Pick<AgentSseEmitter, "emit">;
  clock?: MonitorClock;
}

const DEFAULT_CLOCK: MonitorClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

const toSource = (row: Row): AgentPageSourceDto => ({
  name: row.name,
  run: row.run,
  everyMs: row.every_ms,
  cwd: row.cwd,
  paused: row.paused === 1,
  lastRunAt: row.last_run_at,
  lastError: row.last_error
});

const toData = (row: Row): AgentPageDataDto => ({
  name: row.name,
  value: row.value_json === null ? null : JSON.parse(row.value_json) as unknown,
  at: row.value_at,
  error: row.last_error
});

/**
 * The page's own data sources: the commands sources.json lists, each run on
 * its interval in the user's shell environment, with no model. A run's
 * output is the source's value (JSON when it parses, text otherwise); a
 * failing run keeps the last value and sets the error. The table is the
 * truth; in memory is only which sources run now.
 */
export class PageSourceManager {
  private readonly clock: MonitorClock;
  private readonly running = new Set<string>();
  private active = 0;
  private readonly ticker: unknown;
  private disposed = false;

  constructor(private readonly deps: PageSourceManagerDeps) {
    this.clock = deps.clock ?? DEFAULT_CLOCK;
    this.ticker = this.clock.setInterval(() => {
      void this.runDue().catch((err: unknown) => logError("page sources: a tick failed", err));
    }, TICK_MS);
  }

  /** Reads sources.json and makes the sources what it lists: new ones added,
   *  changed ones changed (a run in flight for the old command is dropped),
   *  the rest removed; a paused one stays paused. A file that is wrong in any
   *  way changes nothing and says why. No file: no sources. */
  applyFile(): { names: string[] | null; error: string | null } {
    const read = this.readFile();
    if ("error" in read) return { names: null, error: read.error };
    const listed = read.listed;
    const now = this.nowIso();
    const before = new Map(this.rows().map((row) => [row.name, row]));
    const changed: string[] = [];
    this.deps.db.transaction(() => {
      for (const [name] of before) {
        if (!listed.some((source) => source.name === name)) this.deps.db.prepare("delete from agent_page_sources where name = ?").run(name);
      }
      listed.forEach((source, position) => {
        const old = before.get(source.name);
        if (!old) {
          this.deps.db.prepare(
            "insert into agent_page_sources (name, position, run, every_ms, cwd, next_run_at, revision) values (?, ?, ?, ?, ?, ?, ?)"
          ).run(source.name, position, source.run, source.everyMs, source.cwd, now, newGeneration());
          changed.push(source.name);
        } else if (old.run !== source.run || old.every_ms !== source.everyMs || old.cwd !== source.cwd) {
          this.deps.db.prepare(
            `update agent_page_sources set position = ?, run = ?, every_ms = ?, cwd = ?, next_run_at = ?, revision = ?
             where name = ?`
          ).run(position, source.run, source.everyMs, source.cwd, now, newGeneration(), source.name);
          changed.push(source.name);
        } else if (old.position !== position) {
          this.deps.db.prepare("update agent_page_sources set position = ? where name = ?").run(position, source.name);
        }
      });
    }).immediate();
    for (const [name] of before) if (!listed.some((source) => source.name === name)) this.emit(name, null);
    for (const name of changed) this.emit(name, this.row(name));
    return { names: listed.map((source) => source.name), error: null };
  }

  list(): AgentPageSourceDto[] {
    return this.rows().map(toSource);
  }

  /** The running sources as sources.json: applied, it changes nothing. */
  fileText(): string {
    const listed = this.rows().map((row) => ({
      name: row.name,
      run: row.run,
      every: formatDurationShort(row.every_ms),
      ...(row.cwd !== null ? { cwd: row.cwd } : {})
    }));
    return `${JSON.stringify(listed, null, 2)}\n`;
  }

  data(name: string): AgentPageDataDto | null {
    const row = this.row(name);
    return row ? toData(row) : null;
  }

  /** Paused, it does not run; resumed, it runs at the next tick. */
  setPaused(name: string, paused: boolean): AgentPageSourceDto | null {
    const changes = paused
      ? this.deps.db.prepare("update agent_page_sources set paused = 1 where name = ?").run(name).changes
      : this.deps.db.prepare("update agent_page_sources set paused = 0, next_run_at = ? where name = ?").run(this.nowIso(), name).changes;
    if (changes === 0) return null;
    const row = this.row(name)!;
    this.emit(name, row);
    return toSource(row);
  }

  /** Gone, and taken out of sources.json so the next apply does not bring
   *  it back. A file that does not parse is left as it is. When the file
   *  was what was last applied, the rewrite is too; a file with edits not yet
   *  applied stays due, so they are applied at its writer's end. */
  remove(name: string): boolean {
    const removed = this.deps.db.prepare("delete from agent_page_sources where name = ?").run(name).changes > 0;
    if (!removed) return false;
    const file = path.join(this.deps.pageDir, PAGE_SOURCES_FILE);
    try {
      const before = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(before) as unknown;
      if (Array.isArray(parsed)) {
        const kept = parsed.filter((entry) => !(entry && typeof entry === "object" && (entry as { name?: unknown }).name === name));
        const content = `${JSON.stringify(kept, null, 2)}\n`;
        const applied = this.deps.store.fileDigest(PAGE_SOURCES_FILE) === pageFileDigest(before);
        fs.writeFileSync(file, content);
        if (applied) this.deps.store.setFileDigest(PAGE_SOURCES_FILE, pageFileDigest(content));
      }
    } catch (err) {
      logError(`page sources: ${name} removed, but sources.json was left as it was`, err);
    }
    this.emit(name, null);
    return true;
  }

  /** Starts the due sources, up to the limit at once; the rest wait for the
   *  next tick. Resolves when the runs it started end. */
  async runDue(): Promise<void> {
    if (this.disposed) return;
    const due = this.deps.db.prepare(
      "select * from agent_page_sources where paused = 0 and next_run_at <= ? order by next_run_at, position"
    ).all(this.nowIso()) as Row[];
    const started: Array<Promise<void>> = [];
    for (const row of due) {
      if (this.running.has(row.name)) continue;
      if (this.active >= AGENT_PAGE_LIMITS.sourceConcurrency) break;
      this.active += 1;
      this.running.add(row.name);
      started.push(this.runOne(row).catch((err: unknown) => logError(`page source ${row.name}: its run failed`, err)).finally(() => {
        this.running.delete(row.name);
        this.active -= 1;
      }));
    }
    await Promise.all(started);
  }

  dispose(): void {
    this.disposed = true;
    this.clock.clearInterval(this.ticker);
  }

  private async runOne(row: Row): Promise<void> {
    const cwd = path.resolve(this.deps.defaultCwd, row.cwd ?? ".");
    let result: MonitorRunResult | { error: string };
    try {
      result = await this.deps.runner.run(row.run, { cwd, timeoutMs: AGENT_PAGE_LIMITS.sourceTimeoutMs });
    } catch (err) {
      // It could not be started at all: a failed run like any other, so it
      // waits its interval and frees its slot for the rest.
      result = { error: `could not run: ${errorText(err)}` };
    }
    if (this.disposed) return;
    const current = this.row(row.name);
    // Removed, or its command changed while it ran: this result is not its.
    if (!current || current.revision !== row.revision) return;
    const now = this.clock.now();
    const at = new Date(now).toISOString();
    const next = new Date(now + current.every_ms).toISOString();
    const outcome = "error" in result ? result : readRun(result);
    // What the page reads is sent only when it changed: a source that runs
    // every minute reads the same thing most times.
    const changed = "error" in outcome
      ? outcome.error !== current.last_error
      : current.last_error !== null || JSON.stringify(outcome.value) !== current.value_json;
    if ("error" in outcome) {
      this.deps.db.prepare("update agent_page_sources set last_run_at = ?, next_run_at = ?, last_error = ? where name = ? and revision = ?")
        .run(at, next, outcome.error, row.name, row.revision);
    } else {
      this.deps.db.prepare(
        "update agent_page_sources set last_run_at = ?, next_run_at = ?, last_error = null, value_json = ?, value_at = ? where name = ? and revision = ?"
      ).run(at, next, JSON.stringify(outcome.value), at, row.name, row.revision);
    }
    const after = this.row(row.name);
    if (after) this.emit(row.name, after, changed);
  }

  /** sources.json, checked whole: the sources it lists, or why not. */
  private readFile(): { listed: Listed[] } | { error: string } {
    const file = path.join(this.deps.pageDir, PAGE_SOURCES_FILE);
    let text: string;
    try {
      if (!fs.existsSync(file)) return { listed: [] };
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      return { error: `sources.json could not be read: ${errorText(err)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { error: `sources.json does not parse: ${errorText(err)}` };
    }
    if (!Array.isArray(parsed)) return { error: "sources.json must be a list of sources" };
    if (parsed.length > AGENT_PAGE_LIMITS.sources) return { error: `at most ${AGENT_PAGE_LIMITS.sources} sources, not ${parsed.length}` };
    const listed: Listed[] = [];
    for (const [index, entry] of parsed.entries()) {
      const checked = checkEntry(entry, index + 1);
      if ("error" in checked) return checked;
      if (listed.some((source) => source.name === checked.name)) return { error: `a duplicate name, ${checked.name}` };
      listed.push(checked);
    }
    return { listed };
  }

  private rows(): Row[] {
    return this.deps.db.prepare("select * from agent_page_sources order by position, rowid").all() as Row[];
  }

  private row(name: string): Row | null {
    return (this.deps.db.prepare("select * from agent_page_sources where name = ?").get(name) as Row | undefined) ?? null;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private emit(name: string, row: Row | null, withData = true): void {
    this.deps.sse.emit(SSE_EVENTS.agentPageSourceChanged, {
      name,
      source: row ? toSource(row) : null,
      ...(withData ? { data: row ? toData(row) : null } : {})
    });
  }
}

function checkEntry(entry: unknown, n: number): Listed | { error: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: `source ${n}: must be an object with name, run and every` };
  const { name, run, every, cwd } = entry as Record<string, unknown>;
  if (typeof name !== "string" || !AGENT_PAGE_SOURCE_NAME.test(name)) {
    return { error: `source ${n}: name ${JSON.stringify(name ?? null)} may use only letters, digits, - and _ (at most 40)` };
  }
  if ((AGENT_PAGE_BUILTINS as readonly string[]).includes(name)) return { error: `source ${n}: ${name} is the name of a built-in source` };
  const label = `source ${n} (${name})`;
  if (typeof run !== "string" || !run.trim()) return { error: `${label}: run must be a shell command` };
  const everyMs = typeof every === "string" ? parseDurationMs(every) : null;
  if (everyMs === null) return { error: `${label}: every must be a duration such as 5m or 1h` };
  if (everyMs < AGENT_PAGE_LIMITS.sourceMinEveryMs || everyMs > AGENT_PAGE_LIMITS.sourceMaxEveryMs) return { error: `${label}: every must be from 1m to 24h` };
  if (cwd !== undefined && cwd !== null && (typeof cwd !== "string" || !cwd.trim() || cwd.includes("\0"))) return { error: `${label}: cwd must be a directory path` };
  return { name, run: run.trim(), everyMs, cwd: typeof cwd === "string" ? cwd.trim() : null };
}

/** A run's value, or why it has none. The output is refused over the
 *  limit, never cut: a cut JSON value is not the value. */
function readRun(result: MonitorRunResult): { value: unknown } | { error: string } {
  if (result.timedOut) return { error: `timed out after ${AGENT_PAGE_LIMITS.sourceTimeoutMs / 1000}s` };
  if (result.exitCode !== 0) {
    const said = (result.stderr.trim() || result.stdout.trim()).slice(0, ERROR_DETAIL_MAX_CHARS);
    return { error: said ? `exit ${result.exitCode}: ${said}` : `exit ${result.exitCode}` };
  }
  const bytes = Buffer.byteLength(result.stdout, "utf8");
  // A full capture holds only the first 256 KB: its size is not the output's.
  if (bytes >= MONITOR_CAPTURE_MAX_BYTES) return { error: "output over 64 KB (more than 256 KB)" };
  if (bytes > AGENT_PAGE_LIMITS.sourceOutputMaxBytes) return { error: `output over 64 KB (${bytes} bytes)` };
  const text = result.stdout.replace(/\s+$/, "");
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { value: text };
  }
}
