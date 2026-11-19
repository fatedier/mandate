import type { Database } from "bun:sqlite";
import { loadavg } from "node:os";

/**
 * The server runs on one thread: synchronous work that holds it (a query,
 * a long computation, a synchronous process call) holds every request, the event stream
 * and every agent with it. Nothing can look while it is held, so the watch
 * notices afterwards: its timer came late. Then it logs how long the thread
 * was held, the recorded work that ran in that time (longest first) and what
 * was under way (requests, tool calls, jobs), so a stall in the log has a
 * name. Work is recorded by `run` (synchronous, kept when it took at least
 * `keepMinMs`) and marked under way by `begin` or `watched`: still going, or
 * ended inside the stall (a handler that held the thread ends before the
 * late timer can look). The process's
 * CPU time in the stall and the machine's load tell the server's own work
 * (CPU time near the stall's length) from a wait (a lock, the disk, a
 * machine too busy to give the server its turn).
 */
export interface StallWatch {
  start(): void;
  stop(): void;
  /** One look at the clock: what the timer runs every `tickMs`. */
  check(): void;
  /** `fn`, timed: kept for a stall to name when it took `keepMinMs` or more. */
  run<T>(label: string, fn: () => T): T;
  /** Under way from now until the returned call. */
  begin(label: string): () => void;
  /** Under way until `fn`'s result settles (at once for a plain value); its
   *  synchronous part is timed as `run` times work. */
  watched<T>(label: string, fn: () => T): T;
}

export interface StallWatchOptions {
  /** A late tick this long or longer is a stall. */
  thresholdMs?: number;
  tickMs?: number;
  /** Shorter work is not kept. */
  keepMinMs?: number;
  now?: () => number;
  clock?: () => Date;
  heapUsed?: () => number;
  /** The process's CPU time so far (user and system). */
  cpuMs?: () => number;
  /** The machine's one-minute load average. */
  loadAverage?: () => number;
  log?: (line: string) => void;
}

interface Span { label: string; start: number; end: number }
interface UnderWay { label: string; start: number; end: number | null }

/** How many recorded spans are kept, newest last. */
const KEEP_SPANS = 256;
/** How many entries a list in the line names before "and N more". */
const NAMED = 4;

export function createStallWatch(options: StallWatchOptions = {}): StallWatch {
  const thresholdMs = options.thresholdMs ?? 100;
  const tickMs = options.tickMs ?? 50;
  // Short enough that many small pieces of one kind add up to their stall.
  const keepMinMs = options.keepMinMs ?? 10;
  const now = options.now ?? (() => performance.now());
  const clock = options.clock ?? (() => new Date());
  const heapUsed = options.heapUsed ?? (() => process.memoryUsage().heapUsed);
  const cpuMs = options.cpuMs ?? (() => { const usage = process.cpuUsage(); return (usage.user + usage.system) / 1000; });
  const loadAverage = options.loadAverage ?? (() => loadavg()[0] ?? 0);
  const log = options.log ?? ((line: string) => { console.log(line); });

  const spans: Span[] = [];
  const inFlight = new Map<number, UnderWay>();
  /** What ended lately, newest last: what ended inside a stall is named too. */
  const ended: UnderWay[] = [];
  let seq = 0;
  let lastTick: number | null = null;
  let lastHeap = 0;
  let lastCpu = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const keep = (label: string, start: number, end: number) => {
    if (end - start < keepMinMs) return;
    spans.push({ label, start, end });
    if (spans.length > KEEP_SPANS) spans.splice(0, spans.length - KEEP_SPANS);
  };

  const check = () => {
    const at = now();
    const heap = heapUsed();
    const cpu = cpuMs();
    if (lastTick !== null) {
      const blocked = at - lastTick - tickMs;
      if (blocked >= thresholdMs) log(stallLine(blocked, lastTick, at, heap, cpu - lastCpu));
    }
    lastTick = at;
    lastHeap = heap;
    lastCpu = cpu;
  };

  const stallLine = (blocked: number, from: number, to: number, heap: number, cpu: number): string => {
    // One entry per kind of work: many small reads of one kind are a stall too.
    const byLabel = new Map<string, { label: string; count: number; ms: number }>();
    for (const span of spans) {
      if (span.end <= from || span.start >= to) continue;
      const entry = byLabel.get(span.label) ?? { label: span.label, count: 0, ms: 0 };
      entry.count += 1;
      entry.ms += span.end - span.start;
      byLabel.set(span.label, entry);
    }
    const ran = [...byLabel.values()].sort((a, b) => b.ms - a.ms);
    const underWay = [...ended.filter((item) => (item.end ?? to) > from), ...inFlight.values()]
      .filter((item) => item.start < to)
      .sort((a, b) => a.start - b.start);
    const parts = [`blocked ${Math.round(blocked)} ms at ${hhmmss(clock())}`];
    parts.push(ran.length > 0
      ? `ran then: ${named(ran.map((entry) => `${entry.label} ${entry.count > 1 ? `${entry.count}× ` : ""}${Math.round(entry.ms)} ms`))}`
      : "nothing recorded ran then");
    // One label named once, with how many and the longest any of them was
    // under way (an ended one beside one still going): several long model
    // streams leave room for other work.
    const underWayByLabel = new Map<string, { label: string; count: number; ms: number }>();
    for (const item of underWay) {
      const ms = (item.end ?? to) - item.start;
      const entry = underWayByLabel.get(item.label);
      if (entry) {
        entry.count += 1;
        entry.ms = Math.max(entry.ms, ms);
      } else underWayByLabel.set(item.label, { label: item.label, count: 1, ms });
    }
    if (underWay.length > 0) parts.push(`under way: ${named([...underWayByLabel.values()].map((entry) => `${entry.label} ${entry.count > 1 ? `${entry.count}× ` : ""}${(entry.ms / 1000).toFixed(1)} s`))}`);
    parts.push(`heap ${mb(lastHeap)} → ${mb(heap)} MB`, `cpu ${Math.round(cpu)} ms`, `load ${loadAverage().toFixed(1)}`);
    return `[mandate] stall: ${parts.join("; ")}`;
  };

  const run = <T>(label: string, fn: () => T): T => {
    const start = now();
    try {
      return fn();
    } finally {
      keep(label, start, now());
    }
  };

  const begin = (label: string): (() => void) => {
    const id = ++seq;
    inFlight.set(id, { label, start: now(), end: null });
    return () => {
      const item = inFlight.get(id);
      if (!item) return;
      inFlight.delete(id);
      ended.push({ ...item, end: now() });
      if (ended.length > KEEP_SPANS) ended.splice(0, ended.length - KEEP_SPANS);
    };
  };

  return {
    start() {
      if (timer) return;
      lastTick = null;
      check();
      timer = setInterval(check, tickMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    check,
    run,
    begin,
    watched<T>(label: string, fn: () => T): T {
      const end = begin(label);
      let result: T;
      try {
        result = run(label, fn);
      } catch (error) {
        end();
        throw error;
      }
      if (isThenable(result)) return Promise.resolve(result).finally(end) as T;
      end();
      return result;
    }
  };
}

/** The process's watch: inert until the server starts it, so code that marks
 *  its work costs a timing and nothing more in tests and tools. */
export const stallWatch: StallWatch = createStallWatch();

/** Times `db`'s statements and `exec`, each named by its SQL, under `watch`.
 *  The same database comes back: callers see no difference. */
export function watchDatabase(db: Database, watch: Pick<StallWatch, "run">): Database {
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  const replaced = db as unknown as Record<string, unknown>;
  replaced.prepare = (sql: string, ...rest: unknown[]) => {
    const statement = (prepare as unknown as (sql: string, ...rest: unknown[]) => Record<string, unknown>)(sql, ...rest);
    const label = sqlLabel(sql);
    for (const method of ["all", "get", "run", "values"] as const) {
      const original = (statement[method] as (...args: unknown[]) => unknown).bind(statement);
      statement[method] = (...args: unknown[]) => watch.run(label, () => original(...args));
    }
    return statement;
  };
  replaced.exec = (sql: string, ...rest: unknown[]) =>
    watch.run(sqlLabel(sql), () => (exec as unknown as (sql: string, ...rest: unknown[]) => unknown)(sql, ...rest));
  // A transaction whole: bun:sqlite issues its BEGIN and COMMIT itself, past
  // the statements timed above, so a commit that waited (on the disk, on a
  // checkpoint) showed as nothing. What the statements inside do not account
  // for is the BEGIN and the COMMIT.
  const transaction = db.transaction.bind(db);
  replaced.transaction = (fn: (...args: unknown[]) => unknown) => {
    const made = transaction(fn) as unknown as Record<string, (...args: unknown[]) => unknown> & ((...args: unknown[]) => unknown);
    const timed = (call: (...args: unknown[]) => unknown) => (...args: unknown[]) => watch.run("sqlite transaction", () => call(...args));
    return Object.assign(timed(made), {
      deferred: timed(made.deferred!),
      immediate: timed(made.immediate!),
      exclusive: timed(made.exclusive!)
    });
  };
  return db;
}

/** A request as a route: the query gone, an id or a number as `:id`. */
export function httpStallLabel(method: string, path: string): string {
  const route = path.split("?")[0]!
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) || /^[a-z]{1,8}_[A-Za-z0-9_-]{6,}$/.test(segment) ? ":id" : segment))
    .join("/");
  return `${method} ${route}`;
}

/** A statement by its SQL. A long column list says little and many reads
 *  share one: all but its last column become "…", so the table and the
 *  condition name it, and two reads of one table and condition that select
 *  different columns still differ. A last column that is an expression goes
 *  too: the text after the last comma may be a piece of it. */
function sqlLabel(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  const head = /^select (distinct )?/i.exec(flat);
  const from = flat.search(/ from /i);
  let shown = flat;
  if (head && from - head[0].length >= 40) {
    const list = flat.slice(head[0].length, from);
    const last = list.slice(list.lastIndexOf(",") + 1).trim();
    const column = /^[\w.]+( as \w+)?$/i.test(last) ? `, ${last}` : "";
    shown = `select ${head[1] ?? ""}…${column}${flat.slice(from)}`;
  }
  return `sqlite ${shown.slice(0, 160)}`;
}

function named(items: string[]): string {
  const shown = items.slice(0, NAMED).join(", ");
  return items.length > NAMED ? `${shown}, and ${items.length - NAMED} more` : shown;
}

function hhmmss(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
