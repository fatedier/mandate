import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { onCleanup } from "./cleanup.js";

/** One run of a statement: how it ran (`all`, `get`, `run`, `values`,
 *  `iterate`), its SQL, its parameters and what it returned. */
export type StatementRun = { method: string; sql: string; params: unknown[]; result: unknown };

const RUN_METHODS = ["all", "get", "run", "values", "iterate"] as const;

type Prepare = (sql: string, ...rest: unknown[]) => unknown;

/**
 * Watches what `db` prepares from now until `stop()` (or the test's end):
 * `prepared` holds the SQL of every statement prepared, and `ran` every run
 * of one whose SQL matches `pattern`. `onPrepare` sees each SQL before it is
 * prepared, for a test that acts at that moment.
 *
 * Only `db.prepare` is watched. `db.query` keeps statements of its own and
 * never goes through it, and a statement prepared before the watch began
 * runs unseen.
 */
export function watchStatements(db: Database, pattern: RegExp = /[\s\S]/, onPrepare?: (sql: string) => void): { prepared: string[]; ran: StatementRun[]; stop: () => void } {
  const prepared: string[] = [];
  const ran: StatementRun[] = [];
  const target = db as unknown as { prepare: Prepare };
  const own = Object.getOwnPropertyDescriptor(target, "prepare");
  const original = target.prepare;
  let watching = true;
  target.prepare = (sql: string, ...rest: unknown[]) => {
    onPrepare?.(sql);
    prepared.push(sql);
    const statement = original.call(db, sql, ...rest) as Record<string, (...params: unknown[]) => unknown>;
    if (!pattern.test(sql)) return statement;
    for (const method of RUN_METHODS) {
      const call = statement[method]!.bind(statement);
      statement[method] = (...params: unknown[]) => {
        const result = call(...params);
        if (watching) ran.push({ method, sql, params, result });
        return result;
      };
    }
    return statement;
  };
  const stop = () => {
    if (!watching) return;
    watching = false;
    if (own) Object.defineProperty(target, "prepare", own);
    else delete (target as Partial<typeof target>).prepare;
  };
  onCleanup(stop);
  return { prepared, ran, stop };
}

/** The statements matching `pattern` that `fn` ran, and what `fn` returned. */
export function statementsRan<T>(db: Database, pattern: RegExp, fn: () => T): { result: T; ran: StatementRun[] } {
  const watch = watchStatements(db, pattern);
  try {
    return { result: fn(), ran: watch.ran };
  } finally {
    watch.stop();
  }
}

/** The SQL of every statement `fn` prepared on `db`, as written. */
export function preparedBy(db: Database, fn: () => unknown): string[] {
  const watch = watchStatements(db);
  try {
    fn();
  } finally {
    watch.stop();
  }
  return watch.prepared;
}

/** As preparedBy, for work that awaits on its way. */
export async function preparedByAsync(db: Database, fn: () => Promise<unknown>): Promise<string[]> {
  const watch = watchStatements(db);
  try {
    await fn();
  } finally {
    watch.stop();
  }
  return watch.prepared;
}

/** The steps of the plan SQLite has for one run, planned with its parameters. */
export function planSteps(db: Database, run: Pick<StatementRun, "sql" | "params">): string[] {
  const plan = db.prepare(`explain query plan ${run.sql}`).all(...(run.params as [])) as Array<{ detail: string }>;
  return plan.map((row) => row.detail);
}

function plansOfRuns(db: Database, pattern: RegExp, ran: StatementRun[]): string[] {
  // A check of no plan at all proves nothing: a pattern that matched no run
  // (the SQL reworded, the read moved) fails here rather than passing.
  expect(ran.length, `No statement matching ${pattern} ran.`).toBeGreaterThan(0);
  return ran.map((run) => planSteps(db, run).join(" | "));
}

/** The plans of the statements matching `pattern` that `fn` ran, in the order
 *  they ran, each one's steps joined by " | ". None ran: the test fails. */
export function plansOf(db: Database, pattern: RegExp, fn: () => unknown): string[] {
  const { ran } = statementsRan(db, pattern, fn);
  return plansOfRuns(db, pattern, ran);
}

/** As plansOf, for work that awaits on its way. */
export async function plansOfAsync(db: Database, pattern: RegExp, fn: () => Promise<unknown>): Promise<string[]> {
  const watch = watchStatements(db, pattern);
  try {
    await fn();
  } finally {
    watch.stop();
  }
  return plansOfRuns(db, pattern, watch.ran);
}
